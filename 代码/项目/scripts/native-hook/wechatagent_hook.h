#pragma once
namespace httplib { class Server; }
void RegisterWeChatAgentRoutes(httplib::Server& server);

#ifdef WECHATAGENT_IMAGE_PROBE
// This seam exists only in the separately compiled offline probe. A production
// DLL cannot enable the synthetic driver through HTTP, environment or config.
#include <filesystem>
void ConfigureWeChatAgentImageProbe(const std::filesystem::path& productDataRoot,
    const std::filesystem::path& controlFile, const std::filesystem::path& auditFile);
#endif
