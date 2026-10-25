#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <bcrypt.h>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <vector>
#include <array>
#include "global.h"
#include "media_sender.h"
#pragma comment(lib,"bcrypt.lib")

namespace WeChatAgentMedia {
namespace {
constexpr uintptr_t ImageFactory=0x1C4CE70,FileFactory=0x22A92B0;
constexpr uintptr_t ImageOwner=0x84F96B8,ImageBody=0x84F9748,FileOwner=0x84F9A78,FileBody=0x8279578;
constexpr uintptr_t Allocate=0x680D0FC,AssignString=0x3043D0,AssignWide=0x96D00;
struct Shared {uintptr_t body,owner;};
static_assert(sizeof(std::string)==32&&sizeof(std::wstring)==32&&sizeof(wchar_t)==2);
bool CoreMatches() {
    auto module=GetModuleHandleW(L"Weixin.dll");if(!module)return false;
    wchar_t name[32768]{};auto count=GetModuleFileNameW(module,name,32768);if(!count||count>=32768)return false;
    std::ifstream input(std::filesystem::path(std::wstring(name,count)),std::ios::binary);if(!input)return false;
    BCRYPT_ALG_HANDLE algorithm=nullptr;BCRYPT_HASH_HANDLE hash=nullptr;
    if(BCryptOpenAlgorithmProvider(&algorithm,BCRYPT_SHA256_ALGORITHM,nullptr,0)<0)return false;
    DWORD length=0,got=0;bool ok=BCryptGetProperty(algorithm,BCRYPT_OBJECT_LENGTH,reinterpret_cast<PUCHAR>(&length),sizeof(length),&got,0)>=0;
    std::vector<unsigned char> object(length),buffer(65536);unsigned char digest[32]{};
    if(ok)ok=BCryptCreateHash(algorithm,&hash,object.data(),length,nullptr,0,0)>=0;
    while(ok&&input){input.read(reinterpret_cast<char*>(buffer.data()),buffer.size());auto n=input.gcount();if(n)ok=BCryptHashData(hash,buffer.data(),static_cast<ULONG>(n),0)>=0;}
    ok=ok&&input.eof()&&BCryptFinishHash(hash,digest,sizeof(digest),0)>=0;
    if(hash)BCryptDestroyHash(hash);BCryptCloseAlgorithmProvider(algorithm,0);
    const unsigned char expected[]={0xf4,0x87,0xe4,0xf5,0x69,0x30,0x45,0x6a,0x25,0xfb,0x0d,0x7b,0x05,0x8c,0x77,0xe2,0xdc,0xd3,0x64,0xe2,0x68,0xd4,0x9b,0xdf,0xff,0x4d,0xc0,0xe3,0xbe,0x26,0xba,0x36};
    return ok&&!memcmp(digest,expected,32);
}
uintptr_t Base(){return reinterpret_cast<uintptr_t>(GetModuleHandleW(L"Weixin.dll"));}
void* New(uintptr_t base,size_t size){auto value=reinterpret_cast<void*(*)(size_t)>(base+Allocate)(size);if(value)memset(value,0,size);return value;}
std::string Utf8(const std::wstring& value){int n=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value.data(),static_cast<int>(value.size()),nullptr,0,nullptr,nullptr);if(n<=0)return {};std::string out(n,'\0');WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,value.data(),static_cast<int>(value.size()),out.data(),n,nullptr,nullptr);return out;}
bool SubmitChecked(const std::string& target,const std::wstring& path,bool file) {
    const auto base=Base();if(!Ready()||reinterpret_cast<uintptr_t>(g_hWeixinDll)!=base)return false;
    Shared message{};
    reinterpret_cast<Shared*(*)(Shared*)>(base+(file?FileFactory:ImageFactory))(&message);
    if(!message.body||message.body!=message.owner+16||*reinterpret_cast<uintptr_t*>(message.owner)!=base+(file?FileOwner:ImageOwner)||
      *reinterpret_cast<uintptr_t*>(message.body)!=base+(file?FileBody:ImageBody))return false;
    // Use the client's constructors, string assignments and allocator. In
    // particular the path's size/capacity remain UTF-16 code units throughout.
    auto narrow=reinterpret_cast<void*(*)(void*,const std::string*)>(base+AssignString);
    auto wide=reinterpret_cast<void*(*)(void*,const std::wstring*)>(base+AssignWide);
    narrow(reinterpret_cast<void*>(message.body+0xB0),&target);
    wide(reinterpret_cast<void*>(message.body+0xE0),&path);
    auto name=Utf8(std::filesystem::path(path).filename().native());if(name.empty())return false;
    narrow(reinterpret_cast<void*>(message.body+0x168),&name);
    *reinterpret_cast<uint32_t*>(message.body+0xD8)=file?49:3;
    *reinterpret_cast<uint32_t*>(message.body+0xDC)=file?6:0;
    *reinterpret_cast<uint64_t*>(message.body+0x188)=std::filesystem::file_size(std::filesystem::path(path));
    // Match send_message's vector input and the reviewed shared parameter
    // builder. Queued work copies shared owners before this function returns.
    auto vector=static_cast<uintptr_t*>(New(base,32));auto first=static_cast<uintptr_t*>(New(base,40));auto second=static_cast<uintptr_t*>(New(base,0xE8));
    auto scratch=New(base,16);std::array<uintptr_t*,3> callbacks{};
    if(!vector||!first||!second||!scratch)return false;
    const uintptr_t tables[]={offset::param2_1,offset::param2_2,offset::param2_3};
    for(size_t i=0;i<3;i++){callbacks[i]=static_cast<uintptr_t*>(New(base,64));if(!callbacks[i])return false;callbacks[i][0]=base+tables[i];callbacks[i][7]=reinterpret_cast<uintptr_t>(callbacks[i]);}
    vector[0]=message.body;vector[1]=message.owner;
    first[0]=base+offset::param1_vtable;first[1]=reinterpret_cast<uintptr_t>(vector);first[2]=first[1]+16;first[3]=first[2];first[4]=1;
    reinterpret_cast<void(*)(void*,void*,void*,void*,void*,uintptr_t)>(base+offset::create_param2)(second,callbacks[0],callbacks[1],callbacks[2],scratch,*reinterpret_cast<uintptr_t*>(base+offset::param2));
    reinterpret_cast<void(*)(void*,void*)>(base+offset::send_message)(first,second);
    // One original reference and its small argument graph remain pinned until
    // process exit, bounded by the route's 128 snapshots per media type.
    return true;
}
bool GuardedSubmit(const std::string& target,const std::wstring& path,bool file){__try{return SubmitChecked(target,path,file);}__except(EXCEPTION_EXECUTE_HANDLER){return false;}}
}
bool Ready(){static const bool matches=CoreMatches();return matches&&Base()!=0;}
bool Submit(const std::string& target,const std::wstring& path,bool file){try{return GuardedSubmit(target,path,file);}catch(...){return false;}}
}
