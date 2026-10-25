// Outer integration endpoints; the upstream send implementation is unchanged.
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <winternl.h>
#include <cwctype>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <set>
#include <vector>
#include <regex>
#include <sstream>
#include <memory>
#include <map>
#include <functional>
#include <stdexcept>
#include <atomic>
#include <bcrypt.h>
#pragma comment(lib,"bcrypt.lib")
#include "httplib.h"
#include "json.hpp"
#include "wx_send.h"
#include "sticker_sender.h"
#include "media_sender.h"
#include "global.h"
#include "wechatagent_hook.h"
#include "deferred_init.h"

using json = nlohmann::json;
static std::timed_mutex sendMutex;

static bool StickerReady() {
    auto module=GetModuleHandleW(L"Weixin.dll");
    if(!module)return false;
    auto base=reinterpret_cast<uintptr_t>(module);
    const auto* dos=reinterpret_cast<const IMAGE_DOS_HEADER*>(base);
    const auto* pe=reinterpret_cast<const IMAGE_NT_HEADERS64*>(base+dos->e_lfanew);
    auto inCode=[base,pe](uintptr_t address){
        if(address<base || address>=base+pe->OptionalHeader.SizeOfImage)return false;
        MEMORY_BASIC_INFORMATION info{};
        if(!VirtualQuery(reinterpret_cast<void*>(address),&info,sizeof(info)) || info.State!=MEM_COMMIT)return false;
        return (info.Protect&(PAGE_EXECUTE|PAGE_EXECUTE_READ|PAGE_EXECUTE_READWRITE|PAGE_EXECUTE_WRITECOPY))!=0;
    };
    if(!inCode(base+offset::send_message) || !inCode(base+offset::create_param2) ||
      !inCode(base+WeChatAgentSticker::EmojiFactory))return false;
    const uintptr_t tables[]={WeChatAgentSticker::EmojiOwnerVtable,WeChatAgentSticker::EmojiVtable,offset::param1_vtable,
      offset::param2_1,offset::param2_2,offset::param2_3};
    for(auto offset:tables){
        if(offset+sizeof(uintptr_t)>pe->OptionalHeader.SizeOfImage)return false;
        MEMORY_BASIC_INFORMATION info{};
        if(!VirtualQuery(reinterpret_cast<void*>(base+offset),&info,sizeof(info)) || info.State!=MEM_COMMIT ||
          (info.Protect&(PAGE_NOACCESS|PAGE_GUARD)))return false;
        if(!inCode(*reinterpret_cast<const uintptr_t*>(base+offset)))return false;
    }
    return true;
}

static bool ForwardSticker(const std::string& target,const std::string& path) {
    __try { return WeixinSend::SendStickerFile(target,path); }
    __except(EXCEPTION_EXECUTE_HANDLER) { return false; }
}

static bool StickerFileMatches(const std::filesystem::path& path,const std::string& md5) {
    std::ifstream input(path,std::ios::binary);
    if(!input)return false;
    std::vector<unsigned char> bytes((std::istreambuf_iterator<char>(input)),{});
    if(bytes.empty() || bytes.size()>8*1024*1024)return false;
    bool media=(bytes.size()>=6 && (!memcmp(bytes.data(),"GIF87a",6)||!memcmp(bytes.data(),"GIF89a",6))) ||
      (bytes.size()>=8 && !memcmp(bytes.data(),"\x89PNG\r\n\x1a\n",8)) ||
      (bytes.size()>=12 && !memcmp(bytes.data(),"RIFF",4)&&!memcmp(bytes.data()+8,"WEBP",4)) ||
      (bytes.size()>=3 && bytes[0]==0xff && bytes[1]==0xd8 && bytes[2]==0xff) ||
      (bytes.size()>=4 && !memcmp(bytes.data(),"wxgf",4));
    if(!media)return false;
    BCRYPT_ALG_HANDLE algorithm=nullptr;
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_MD5_ALGORITHM,nullptr,0)<0)return false;
    unsigned char digest[16]{};
    auto result=BCryptHash(algorithm,nullptr,0,bytes.data(),static_cast<ULONG>(bytes.size()),digest,16);
    BCryptCloseAlgorithmProvider(algorithm,0);
    if(result<0)return false;
    static constexpr char hex[]="0123456789abcdef";std::string actual;
    for(auto value:digest){actual+=hex[value>>4];actual+=hex[value&15];}
    return actual==md5;
}

static std::string Utf8(const std::wstring& value) {
    int size = WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), nullptr, 0, nullptr, nullptr);
    std::string out(size, '\0');
    if (size) WideCharToMultiByte(CP_UTF8, 0, value.data(), (int)value.size(), out.data(), size, nullptr, nullptr);
    return out;
}

static std::wstring ModulePath(HMODULE module = nullptr) {
    wchar_t file[32768] = {};
    DWORD size = GetModuleFileNameW(module, file, 32768);
    return size && size < 32768 ? std::wstring(file, size) : L"";
}

static std::string CoreVersion() {
    std::wstring path = ModulePath(GetModuleHandleW(L"Weixin.dll"));
    DWORD ignored = 0, size = GetFileVersionInfoSizeW(path.c_str(), &ignored);
    if (!size) return "";
    std::vector<BYTE> bytes(size);
    if (!GetFileVersionInfoW(path.c_str(), 0, size, bytes.data())) return "";
    VS_FIXEDFILEINFO* info = nullptr;
    UINT length = 0;
    if (!VerQueryValueW(bytes.data(), L"\\", (void**)&info, &length) || !info) return "";
    return std::to_string(HIWORD(info->dwFileVersionMS)) + "." +
        std::to_string(LOWORD(info->dwFileVersionMS)) + "." +
        std::to_string(HIWORD(info->dwFileVersionLS)) + "." +
        std::to_string(LOWORD(info->dwFileVersionLS));
}

// Query this process's file handles, without reading database pages or keys.
// ProcessHandleInformation is supported on Windows 8+; failure closes the gate.
struct HandleEntry {
    HANDLE value;
    ULONG_PTR handleCount, pointerCount;
    ULONG grantedAccess, objectTypeIndex, attributes, reserved;
};
struct HandleSnapshot { ULONG_PTR count, reserved; HandleEntry entries[1]; };

static std::set<std::string> DatabaseAccounts() {
    using Query = NTSTATUS(NTAPI*)(HANDLE, ULONG, PVOID, ULONG, PULONG);
    auto query = (Query)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryInformationProcess");
    if (!query) return {};
    std::vector<BYTE> buffer(65536);
    ULONG required = 0;
    NTSTATUS status = query(GetCurrentProcess(), 51, buffer.data(), (ULONG)buffer.size(), &required);
    if (status < 0 && required > buffer.size() && required < 16 * 1024 * 1024) {
        buffer.resize(required + 4096);
        status = query(GetCurrentProcess(), 51, buffer.data(), (ULONG)buffer.size(), &required);
    }
    if (status < 0) return {};
    auto* snapshot = (HandleSnapshot*)buffer.data();
    if (snapshot->count > (buffer.size() - 2 * sizeof(ULONG_PTR)) / sizeof(HandleEntry)) return {};
    std::set<std::string> accounts;
    for (ULONG_PTR i = 0; i < snapshot->count; ++i) {
        HANDLE file = snapshot->entries[i].value;
        if (GetFileType(file) != FILE_TYPE_DISK) continue;
        wchar_t name[32768] = {};
        DWORD size = GetFinalPathNameByHandleW(file, name, 32768, FILE_NAME_NORMALIZED);
        if (!size || size >= 32768) continue;
        std::wstring path(name, size);
        for (auto& ch : path) { if (ch == L'/') ch = L'\\'; ch = towlower(ch); }
        const std::wstring marker = L"\\db_storage\\";
        size_t at = path.find(marker);
        if (at == std::wstring::npos) continue;
        std::wstring suffix = path.substr(at + marker.size());
        if (suffix != L"contact\\contact.db" && suffix != L"contact\\contact.db-wal" &&
            suffix != L"session\\session.db" && suffix.rfind(L"message\\message_", 0) != 0) continue;
        size_t previous = path.rfind(L'\\', at - 1);
        if (previous != std::wstring::npos) accounts.insert(Utf8(path.substr(previous + 1, at - previous - 1)));
    }
    return accounts;
}

namespace {
// Media uses product-owned native factories. A local installation manifest
// supplies the one permitted snapshot root; HTTP cannot choose that root.
struct ImageDriver {
    std::filesystem::path root;
    std::function<bool()> ready = [] { return false; };
    std::function<std::string()> version = CoreVersion;
    std::function<std::set<std::string>()> accounts = DatabaseAccounts;
    std::function<bool(const std::string&, const std::wstring&)> submit;
};
static std::shared_ptr<ImageDriver> imageDriver = std::make_shared<ImageDriver>();
struct ImageFault : std::runtime_error {
    int status;
    ImageFault(const char* code, int value = 400) : std::runtime_error(code), status(value) {}
};
struct PinnedHandle {
    HANDLE value = INVALID_HANDLE_VALUE;
    explicit PinnedHandle(HANDLE handle) : value(handle) {}
    ~PinnedHandle() { if (value != INVALID_HANDLE_VALUE) CloseHandle(value); }
    PinnedHandle(const PinnedHandle&) = delete;
    PinnedHandle& operator=(const PinnedHandle&) = delete;
};
using Pin = std::shared_ptr<PinnedHandle>;
struct ImageSnapshot { std::vector<Pin> pins; std::filesystem::path path; };

static std::wstring StrictWide(const std::string& text) {
    if (text.empty() || text.size() > 4096 || text.find('\0') != std::string::npos) throw ImageFault("IMAGE_INVALID_UTF8");
    int count = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (count <= 0) throw ImageFault("IMAGE_INVALID_UTF8");
    std::wstring wide(count, L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text.data(), static_cast<int>(text.size()), wide.data(), count) != count) throw ImageFault("IMAGE_INVALID_UTF8");
    return wide;
}
static std::filesystem::path ImagePath(const std::wstring& value) {
    if (value.size() < 4 || value.size() > 1024 || !iswalpha(value[0]) || value[1] != L':' ||
        (value[2] != L'\\' && value[2] != L'/') || value.find(L':', 2) != std::wstring::npos || value.find(L'\0') != std::wstring::npos) throw ImageFault("IMAGE_PATH_REFUSED");
    std::filesystem::path result(value);
    for (const auto& part : result.relative_path()) {
        auto name = part.native();
        if (name.empty() || name == L"." || name == L".." || name.back() == L'.' || name.back() == L' ' ||
            name.find_first_of(L"<>\"|?*") != std::wstring::npos) throw ImageFault("IMAGE_PATH_REFUSED");
    }
    return result.lexically_normal();
}
static bool SamePath(const std::filesystem::path& left, const std::filesystem::path& right) {
    return _wcsicmp(left.native().c_str(), right.native().c_str()) == 0;
}
static Pin PinFile(const std::filesystem::path& path, bool directory) {
    HANDLE value = CreateFileW(path.c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ,
        directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr);
    if (value == INVALID_HANDLE_VALUE) throw ImageFault("IMAGE_PATH_UNAVAILABLE");
    auto pin = std::make_shared<PinnedHandle>(value);
    FILE_ATTRIBUTE_TAG_INFO attributes{};
    if (GetFileType(value) != FILE_TYPE_DISK || !GetFileInformationByHandleEx(value, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
        attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT || bool(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory) throw ImageFault("IMAGE_PATH_REFUSED");
    return pin;
}
static std::vector<Pin> PinChain(const std::filesystem::path& path, bool directory) {
    std::vector<Pin> pins;
    auto current = path.root_path();
    pins.push_back(PinFile(current, true));
    for (const auto& part : path.relative_path()) {
        current /= part;
        pins.push_back(PinFile(current, !SamePath(current, path) || directory));
    }
    return pins;
}
static std::vector<unsigned char> ReadPinned(const Pin& file, size_t limit) {
    LARGE_INTEGER length{};
    if (!GetFileSizeEx(file->value, &length) || length.QuadPart <= 0 || length.QuadPart > static_cast<LONGLONG>(limit)) throw ImageFault("IMAGE_FILE_SIZE_REFUSED");
    std::vector<unsigned char> bytes(static_cast<size_t>(length.QuadPart));
    DWORD count = 0;
    if (!ReadFile(file->value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) || count != bytes.size()) throw ImageFault("IMAGE_FILE_READ_FAILED");
    return bytes;
}
static std::string ImageHash(const unsigned char* bytes, size_t length) {
    BCRYPT_ALG_HANDLE algorithm = nullptr;
    if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) throw ImageFault("IMAGE_HASH_FAILED", 503);
    unsigned char digest[32]{};
    auto result = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(bytes), static_cast<ULONG>(length), digest, 32);
    BCryptCloseAlgorithmProvider(algorithm, 0);
    if (result < 0) throw ImageFault("IMAGE_HASH_FAILED", 503);
    static const char hex[] = "0123456789abcdef";
    std::string value;
    for (auto byte : digest) { value += hex[byte >> 4]; value += hex[byte & 15]; }
    return value;
}
static std::string ImageHash(const std::string& value) { return ImageHash(reinterpret_cast<const unsigned char*>(value.data()), value.size()); }
static ImageSnapshot InspectImage(const ImageDriver& driver, const json& data, bool file = false) {
    auto root = ImagePath(driver.root.native());
    auto image = ImagePath(StrictWide(data.at("path").get<std::string>()));
    auto name = StrictWide(data.at("name").get<std::string>());
    if (!SamePath(image.parent_path().parent_path(), root / L"wechat" / L"outgoing") || image.filename().native() != name ||
        !std::regex_match(Utf8(image.parent_path().filename().native()), std::regex("wxatt_[a-f0-9]{32}")) ||
        !data.at("size").is_number_unsigned() || data.at("size").get<uint64_t>() == 0 || data.at("size").get<uint64_t>() > (file?50:8) * 1024 * 1024) throw ImageFault("IMAGE_SNAPSHOT_REFUSED");
    auto pins = PinChain(image, false);
    auto bytes = ReadPinned(pins.back(), (file?50:8) * 1024 * 1024);
    if (bytes.size() != data.at("size").get<uint64_t>() || ImageHash(bytes.data(), bytes.size()) != data.at("sha256").get<std::string>()) throw ImageFault("IMAGE_INTEGRITY_FAILED");
    auto extension = image.extension().native();
    for (auto& value : extension) value = towlower(value);
    auto mime = data.at("mime").get<std::string>();
    if(file){if(!std::regex_match(mime,std::regex("[a-z0-9.+-]+/[a-z0-9.+-]+")))throw ImageFault("IMAGE_FORMAT_UNSUPPORTED");return {std::move(pins),image};}
    bool png = bytes.size() >= 8 && !memcmp(bytes.data(), "\x89PNG\r\n\x1a\n", 8);
    bool jpeg = bytes.size() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff;
    if (!(png && extension == L".png" && mime == "image/png") && !(jpeg && (extension == L".jpg" || extension == L".jpeg") && mime == "image/jpeg")) throw ImageFault("IMAGE_FORMAT_UNSUPPORTED");
    return { std::move(pins), image };
}
static void WriteImageState(const std::filesystem::path& filename, const json& record, bool first) {
    auto text = record.dump();
    // CREATE_NEW is the durable one-shot reservation. A damaged or interrupted
    // record is retained, never removed to turn an unknown outcome into a retry.
    auto destination = first ? filename : std::filesystem::path(filename.native() + L".next");
    HANDLE value = CreateFileW(destination.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (value == INVALID_HANDLE_VALUE) throw ImageFault("IMAGE_STATE_UNAVAILABLE", 503);
    bool saved = false;
    { PinnedHandle pin(value); DWORD count = 0;
      saved = WriteFile(value, text.data(), static_cast<DWORD>(text.size()), &count, nullptr) && count == text.size() && FlushFileBuffers(value); }
    if (!saved || (!first && !MoveFileExW(destination.c_str(), filename.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))) throw ImageFault("IMAGE_STATE_UNAVAILABLE", 503);
}
static void ImageReply(httplib::Response& response, int status, const char* code, bool attempted = false) {
    response.status = status;
    response.set_content(json{{"ret", 1}, {"error", code}, {"attempted", attempted}, {"retryable", false}}.dump(), "application/json");
}
static void RegisterImageRoute(httplib::Server& server, std::function<bool(const httplib::Request&, httplib::Response&)> authorized,
    std::shared_ptr<ImageDriver> driver, bool file = false) {
    // Held snapshot handles prevent replacement or writes while native work may
    // still consume its path. The bounded driver lifetime is the Hook process.
    auto held = std::make_shared<std::map<std::string, ImageSnapshot>>();
    server.Post(file?"/SendFileMsg":"/SendImgMsg", [authorized, driver, held, file](const httplib::Request& request, httplib::Response& response) {
        if (!authorized(request, response)) return;
        bool attempted = false;
        try {
            // No config, path lookup, directory creation or ledger writes happen
            // for production requests while the ABI is explicitly unsupported.
            if (!driver->ready() || !driver->submit) { ImageReply(response, 503, "IMAGE_NATIVE_ABI_UNVERIFIED"); return; }
            auto account = request.get_header_value("X-WeChatAgent-Account");
            auto identity = [&] {
                auto accounts = driver->accounts();
                if (driver->version() != "4.1.10.27" || account.empty() || accounts.size() != 1 || !accounts.count(account)) throw ImageFault("IMAGE_ACCOUNT_OR_VERSION_MISMATCH", 409);
            };
            identity();
            auto data = json::parse(request.body);
            const std::set<std::string> keys = {"wxidorgid", "path", "name", "size", "sha256", "mime", "deliveryId"};
            if (!data.is_object() || data.size() != keys.size()) throw ImageFault("IMAGE_REQUEST_INVALID");
            for (auto it = data.begin(); it != data.end(); ++it) if (!keys.count(it.key())) throw ImageFault("IMAGE_REQUEST_INVALID");
            auto target = data.at("wxidorgid").get<std::string>(), id = data.at("deliveryId").get<std::string>();
            if (!std::regex_match(target, std::regex("[A-Za-z0-9_.@-]{1,256}")) ||
                !std::regex_match(id, std::regex("[a-f0-9]{64}")) || !std::regex_match(data.at("sha256").get<std::string>(), std::regex("[a-f0-9]{64}"))) throw ImageFault("IMAGE_REQUEST_INVALID");
            std::unique_lock<std::timed_mutex> lock(sendMutex, std::defer_lock);
            if (!lock.try_lock_for(std::chrono::seconds(1))) throw ImageFault("IMAGE_SENDER_BUSY", 429);
            identity();
            auto root = ImagePath(driver->root.native());
            auto rootPins = PinChain(root / L"wechat", true);
            auto ledger = root / L"wechat" / L"native-image-deliveries";
            if (!CreateDirectoryW(ledger.c_str(), nullptr) && GetLastError() != ERROR_ALREADY_EXISTS) throw ImageFault("IMAGE_STATE_UNAVAILABLE", 503);
            auto ledgerPin = PinFile(ledger, true);
            auto key = ImageHash(json::array({account, id}).dump()), fingerprint = ImageHash(json::array({file?"file":"image",data}).dump());
            auto filename = ledger / (key + ".json");
            auto attributes = GetFileAttributesW(filename.c_str());
            if (attributes != INVALID_FILE_ATTRIBUTES) {
                attempted = true; // Existing/damaged state is never proof of no submission.
                auto bytes = ReadPinned(PinFile(filename, false), 16384);
                auto record = json::parse(bytes.begin(), bytes.end());
                if (record.at("version") != 1 || record.at("deliveryId") != id || !record.at("fingerprint").is_string() ||
                    !record.at("state").is_string()) throw ImageFault("IMAGE_STATE_INVALID", 409);
                if (record.at("fingerprint") != fingerprint) throw ImageFault("IMAGE_DELIVERY_CONFLICT", 409);
                if (record.at("state") == "accepted") {
                    response.set_content(json{{"ret", 0}, {"retmsg", "accepted"}, {"attempted", true}, {"reused", true}, {"deliveryId", id}, {"delivered", false}}.dump(), "application/json"); return;
                }
                throw ImageFault("IMAGE_DELIVERY_UNCONFIRMED", 409);
            }
            if (GetLastError() != ERROR_FILE_NOT_FOUND) throw ImageFault("IMAGE_STATE_UNAVAILABLE", 503);
            if (held->size() >= 128) throw ImageFault("IMAGE_INFLIGHT_LIMIT", 429);
            auto snapshot = InspectImage(*driver, data, file);
            identity();
            if (!driver->ready()) throw ImageFault("IMAGE_NATIVE_ABI_UNVERIFIED", 503);
            auto record = json{{"version", 1}, {"deliveryId", id}, {"fingerprint", fingerprint}, {"state", "unknown"}};
            attempted = true; // Set before reservation: any storage failure stays conservative.
            WriteImageState(filename, record, true);
            auto path = snapshot.path.native();
            held->emplace(key, std::move(snapshot));
            if (!driver->submit(target, path)) throw ImageFault("IMAGE_DELIVERY_UNCONFIRMED", 502);
            record["state"] = "accepted";
            WriteImageState(filename, record, false);
            // Acceptance only. No invented server ID, delivery receipt or claim
            // of successful sending; the product must use exact new DB evidence.
            response.set_content(json{{"ret", 0}, {"retmsg", "accepted"}, {"attempted", true}, {"reused", false}, {"deliveryId", id}, {"delivered", false}}.dump(), "application/json");
        } catch (const ImageFault& error) { ImageReply(response, error.status, error.what(), attempted); }
        catch (...) { ImageReply(response, attempted ? 409 : 400, attempted ? "IMAGE_DELIVERY_UNCONFIRMED" : "IMAGE_REQUEST_INVALID", attempted); }
    });
}
}

#ifdef WECHATAGENT_IMAGE_PROBE
void ConfigureWeChatAgentImageProbe(const std::filesystem::path& root, const std::filesystem::path& control, const std::filesystem::path& audit) {
    auto driver = std::make_shared<ImageDriver>();
    driver->root = ImagePath(root.native());
    auto settings = [control] { std::ifstream input(control); return json::parse(input); };
    driver->ready = [settings] { return settings().value("ready", false); };
    driver->version = [settings] { return settings().value("version", ""); };
    auto checks = std::make_shared<std::atomic<unsigned int>>(0);
    driver->accounts = [settings, checks] {
        auto options = settings(); auto check = ++*checks;
        return options.contains("accountsAfterChecks") && check > options.value("changeAfterChecks", 0u)
            ? options.at("accountsAfterChecks").get<std::set<std::string>>() : options.at("accounts").get<std::set<std::string>>();
    };
    driver->submit = [settings, audit](const std::string& target, const std::wstring& path) {
        auto options = settings();
        { std::ofstream output(audit, std::ios::app); output << json{{"target", target}, {"path", Utf8(path)}, {"utf16Length", path.size()}}.dump() << '\n'; output.flush(); if (!output) throw std::runtime_error("probe audit failed"); }
        if (options.value("outcome", "") == "crash") ExitProcess(8);
        Sleep(options.value("delayMs", 0u));
        return options.value("outcome", "") == "accepted";
    };
    imageDriver = std::move(driver);
}
#endif

void RegisterWeChatAgentRoutes(httplib::Server& server) {
#ifndef WECHATAGENT_IMAGE_PROBE
    // Only the trusted local updater writes this manifest beside version.dll.
    // Absent or invalid configuration keeps the existing unsupported response.
    try {
        std::ifstream manifest(std::filesystem::path(ModulePath()).parent_path()/L"xiaozhushou-media-root.json");
        if(manifest){auto options=json::parse(manifest);if(options.size()!=2||options.at("version")!=1)throw std::runtime_error("manifest");
            auto root=ImagePath(StrictWide(options.at("dataRoot").get<std::string>()));auto pins=PinChain(root/L"wechat",true);
            imageDriver->root=root;imageDriver->ready=WeChatAgentMedia::Ready;
            imageDriver->submit=[](const std::string& target,const std::wstring& path){return WeChatAgentMedia::Submit(target,path,false);};}
    }catch(...){imageDriver=std::make_shared<ImageDriver>();}
#endif
    std::ifstream file(std::filesystem::path(ModulePath()).parent_path() / L"wechatagent-hook.token");
    std::string token;
    std::getline(file, token);
    if (!token.empty() && token.back() == '\r') token.pop_back();
    server.set_payload_max_length(65536);
    auto authorized = [token](const httplib::Request& req, httplib::Response& res) {
        std::string supplied = req.get_header_value("Authorization"), expected = "Bearer " + token;
        unsigned int difference = (unsigned int)(supplied.size() ^ expected.size());
        for (size_t i = 0; i < expected.size(); ++i) difference |= expected[i] ^ (i < supplied.size() ? supplied[i] : 0);
        if (token.size() != 64 || difference) {
            res.status = 401; res.set_content("{\"error\":\"Unauthorized\"}", "application/json");
            return false;
        }
        return true;
    };
    server.Get("/WeChatAgent/health", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        json data = {{"backend", "wechat-hook"}, {"integration", "WeChatAgent-1"},
            {"version", CoreVersion()}, {"pid", GetCurrentProcessId()}, {"databaseAccounts", DatabaseAccounts()}, {"nativeStickerSend",StickerReady()},
            {"initialization", "deferred-module-v1"}, {"startupState", WeChatAgentInitState()},
            {"nativeImageSend", imageDriver->ready()&&bool(imageDriver->submit)}, {"nativeFileSend", imageDriver->ready()&&bool(imageDriver->submit)},
            {"mediaProtocol", "xiaozhushou-native-media-v1"}, {"imageSendStatus", imageDriver->ready()&&bool(imageDriver->submit)?"native-factory-v1":"IMAGE_NATIVE_ABI_UNVERIFIED"}};
        res.set_content(data.dump(), "application/json");
    });
    RegisterImageRoute(server, authorized, imageDriver);
    auto fileDriver=std::make_shared<ImageDriver>(*imageDriver);
#ifndef WECHATAGENT_IMAGE_PROBE
    if(fileDriver->submit)fileDriver->submit=[](const std::string& target,const std::wstring& path){return WeChatAgentMedia::Submit(target,path,true);};
#endif
    RegisterImageRoute(server, authorized, fileDriver, true);
    server.Post("/SendStickerMsg",[authorized](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        try{
            auto accounts=DatabaseAccounts();auto account=req.get_header_value("X-WeChatAgent-Account");
            if(CoreVersion()!="4.1.10.27" || accounts.size()!=1 || !accounts.count(account)){
                res.status=409;res.set_content("{\"ret\":1,\"error\":\"Version or account mismatch\"}","application/json");return;
            }
            if(!StickerReady()){
                res.status=409;res.set_content("{\"ret\":1,\"error\":\"Sticker native layout unavailable\"}","application/json");return;
            }
            auto data=json::parse(req.body);auto target=data.value("wxidorgid","");auto fields=data.at("sticker");
            std::string file=data.value("path","");
            std::string md5=fields.value("md5",""),product=fields.value("productid","");
            int length=fields.value("len",0),type=fields.value("type",0),width=fields.value("width",0),height=fields.value("height",0);
            if(target.empty() || target.size()>256 || !std::regex_match(md5,std::regex("[a-f0-9]{32}")) ||
              !std::regex_match(product,std::regex("[A-Za-z0-9._-]{0,128}")) || length<0 || length>8*1024*1024 ||
              type<0 || type>5 || width<0 || width>4096 || height<0 || height>4096){
                res.status=400;res.set_content("{\"ret\":1,\"error\":\"Invalid sticker metadata\"}","application/json");return;
            }
            auto allowed=std::filesystem::weakly_canonical(std::filesystem::path(ModulePath()).parent_path().parent_path().parent_path().parent_path()/L"state"/L"stickers"/L"outgoing");
            auto image=std::filesystem::weakly_canonical(std::filesystem::path(std::u8string(reinterpret_cast<const char8_t*>(file.data()),file.size())));
            auto extension=image.extension().string();
            if(image.parent_path()!=allowed || image.stem().string()!=md5 ||
              !(extension==".gif"||extension==".png"||extension==".wxgf"||extension==".webp"||extension==".jpg") ||
              !std::filesystem::is_regular_file(image) || std::filesystem::file_size(image)>8*1024*1024 || !StickerFileMatches(image,md5)){
                res.status=400;res.set_content("{\"ret\":1,\"error\":\"Invalid sticker file\"}","application/json");return;
            }
            std::unique_lock<std::timed_mutex> lock(sendMutex,std::defer_lock);
            if(!lock.try_lock_for(std::chrono::seconds(1))){res.status=429;res.set_content("{\"ret\":1}","application/json");return;}
            bool accepted=ForwardSticker(target,file);
            res.set_content(accepted?"{\"ret\":0,\"retmsg\":\"accepted\"}":"{\"ret\":1,\"error\":\"Native sticker rejected\"}","application/json");
        }catch(...){res.status=400;res.set_content("{\"ret\":1,\"error\":\"Invalid sticker request\"}","application/json");}
    });
    server.Post("/WeChatAgent/sticker-trace",[authorized](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        auto accounts=DatabaseAccounts();auto account=req.get_header_value("X-WeChatAgent-Account");
        if(CoreVersion()!="4.1.10.27" || accounts.size()!=1 || !accounts.count(account)){res.status=409;res.set_content("{}","application/json");return;}
        try {
            auto data=json::parse(req.body);auto target=data.value("wxidorgid","");
            if(target.size()>256){res.status=400;res.set_content("{}","application/json");return;}
            if(!WeChatAgentSticker::StartTrace(target)){res.status=503;res.set_content("{}","application/json");return;}
            res.set_content(WeChatAgentSticker::TraceJson(),"application/json");
        }catch(...){res.status=400;res.set_content("{}","application/json");}
    });
    server.Get("/WeChatAgent/sticker-trace",[authorized](const httplib::Request& req,httplib::Response& res){
        if(!authorized(req,res))return;
        res.set_content(WeChatAgentSticker::TraceJson(),"application/json");
    });
    server.Post("/SendTextMsg", [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        try {
            auto accounts = DatabaseAccounts();
            std::string account = req.get_header_value("X-WeChatAgent-Account");
            if (CoreVersion() != "4.1.10.27" || account.empty() || accounts.size() != 1 || !accounts.count(account)) {
                res.status = 409; res.set_content("{\"ret\":1,\"error\":\"Version or account mismatch\"}", "application/json"); return;
            }
            json data = json::parse(req.body);
            std::string target = data.value("wxidorgid", ""), text = data.value("msg", "");
            if (target.empty() || target.size() > 256 || text.empty() || text.size() > 16000) {
                res.status = 400; res.set_content("{\"ret\":1}", "application/json"); return;
            }
            std::unique_lock<std::timed_mutex> lock(sendMutex, std::defer_lock);
            if (!lock.try_lock_for(std::chrono::seconds(1))) {
                res.status = 429; res.set_content("{\"ret\":1,\"error\":\"Busy\"}", "application/json"); return;
            }
            WeixinSend::SendText(target, text);
            // Acceptance only. The OneBot adapter still requires a new server receipt.
            res.set_content("{\"ret\":0,\"retmsg\":\"accepted\"}", "application/json");
        } catch (...) {
            res.status = 500; res.set_content("{\"ret\":1,\"error\":\"Native send failed\"}", "application/json");
        }
    });
    // Route handlers run after the bounded request body is read. Rejecting a
    // POST before reading its body can reset TCP and truncate the error JSON.
    auto unknown = [authorized](const httplib::Request& req, httplib::Response& res) {
        if (!authorized(req, res)) return;
        res.status = 404; res.set_content("{}", "application/json");
    };
    server.Get(".*", unknown);
    server.Post(".*", unknown);
}
