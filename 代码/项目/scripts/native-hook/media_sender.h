#pragma once
#include <string>
namespace WeChatAgentMedia {
bool Ready();
bool Submit(const std::string& target,const std::wstring& path,bool file);
}
