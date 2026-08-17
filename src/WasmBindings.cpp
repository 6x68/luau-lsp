#ifdef __EMSCRIPTEN__
#include "LSP/LanguageServer.hpp"
#include "LSP/Transport/WasmTransport.hpp"
#include "LSP/JsonRpc.hpp"
#include "LuauFileUtils.hpp"
#include "Flags.hpp"

#include <emscripten.h>
#include <string>
#include <memory>
#include <functional>
#include <cstring>

// Callback function types
typedef const char* (*WasmReadFileCallback)(const char* path);
typedef int (*WasmFileExistsCallback)(const char* path);
typedef int (*WasmIsFileCallback)(const char* path);
typedef int (*WasmIsDirectoryCallback)(const char* path);
typedef const char* (*WasmDirListCallback)(const char* path);
typedef const char* (*WasmGetCurrentDirectoryCallback)();
typedef const char* (*WasmHttpFetchCallback)(const char* url);
typedef const char* (*WasmCommandCallback)(const char* command);

static WasmReadFileCallback s_readFile = nullptr;
static WasmFileExistsCallback s_fileExists = nullptr;
static WasmIsFileCallback s_isFile = nullptr;
static WasmIsDirectoryCallback s_isDirectory = nullptr;
static WasmDirListCallback s_dirList = nullptr;
static WasmGetCurrentDirectoryCallback s_getCurrentDirectory = nullptr;
static WasmHttpFetchCallback s_httpFetch = nullptr;
static WasmCommandCallback s_command = nullptr;

static std::unique_ptr<WasmTransport> s_transport;
static std::unique_ptr<LSPClient> s_client;
static std::unique_ptr<LanguageServer> s_server;

static char* dupString(const std::string& str)
{
    char* result = static_cast<char*>(malloc(str.size() + 1));
    memcpy(result, str.c_str(), str.size());
    result[str.size()] = '\0';
    return result;
}

extern "C"
{
    EMSCRIPTEN_KEEPALIVE void lsp_register_callbacks(
        WasmReadFileCallback readFile,
        WasmFileExistsCallback fileExists,
        WasmIsFileCallback isFile,
        WasmIsDirectoryCallback isDirectory,
        WasmDirListCallback dirList,
        WasmGetCurrentDirectoryCallback getCurrentDirectory,
        WasmHttpFetchCallback httpFetch,
        WasmCommandCallback command)
    {
        s_readFile = readFile;
        s_fileExists = fileExists;
        s_isFile = isFile;
        s_isDirectory = isDirectory;
        s_dirList = dirList;
        s_getCurrentDirectory = getCurrentDirectory;
        s_httpFetch = httpFetch;
        s_command = command;
    }

    EMSCRIPTEN_KEEPALIVE int lsp_init()
    {
        Luau::assertHandler() = [](const char* expr, const char* file, int line, const char*) -> int
        {
            fprintf(stderr, "%s(%d): ASSERTION FAILED: %s\n", file, line, expr);
            return 1;
        };

        applyRequiredFlags();

        s_transport = std::make_unique<WasmTransport>();
        s_client = std::make_unique<LSPClient>(std::move(s_transport));
        s_server = std::make_unique<LanguageServer>(s_client.get(), std::nullopt);

        return 0;
    }

    EMSCRIPTEN_KEEPALIVE const char* lsp_process_message(const char* json_message)
    {
        if (!s_server || !json_message)
            return nullptr;

        std::string input(json_message);

        try
        {
            auto msg = json_rpc::parse(input);

            if (msg.is_request() && msg.method == "shutdown")
            {
                s_server->shutdown();
                s_server->handleMessage(msg);
            }
            else if (msg.is_notification() && msg.method == "exit")
            {
                // No-op in WASM; just acknowledge
            }
            else
            {
                s_server->handleMessage(msg);
            }
        }
        catch (const std::exception& e)
        {
            return dupString("{\"jsonrpc\":\"2.0\",\"error\":{\"code\":-32603,\"message\":\"" + std::string(e.what()) + "\"},\"id\":null}");
        }

        std::string response = s_transport->getAndClearResponse();
        if (response.empty())
            return nullptr;

        return dupString(response);
    }

    EMSCRIPTEN_KEEPALIVE void lsp_push_message(const char* json_message)
    {
        if (s_server && json_message)
            s_server->pushMessage(json_message);
    }

    EMSCRIPTEN_KEEPALIVE const char* lsp_get_response()
    {
        if (!s_transport)
            return nullptr;

        std::string response = s_transport->getAndClearResponse();
        if (response.empty())
            return nullptr;

        return dupString(response);
    }

    EMSCRIPTEN_KEEPALIVE void lsp_shutdown()
    {
        if (s_server)
            s_server->shutdown();
    }
}

// Override Luau FileUtils functions to use callbacks
namespace Luau::FileUtils
{
    std::optional<std::string> readFile(const std::string& name)
    {
        if (s_readFile)
        {
            const char* result = s_readFile(name.c_str());
            if (result)
            {
                std::string content(result);
                return content;
            }
        }
        return std::nullopt;
    }

    bool exists(const std::string& path)
    {
        if (s_fileExists)
            return s_fileExists(path.c_str()) != 0;
        return false;
    }

    bool isFile(const std::string& path)
    {
        if (s_isFile)
            return s_isFile(path.c_str()) != 0;
        return false;
    }

    bool isDirectory(const std::string& path)
    {
        if (s_isDirectory)
            return s_isDirectory(path.c_str()) != 0;
        return false;
    }

    bool traverseDirectory(const std::string& path, const std::function<void(const std::string& name)>& callback)
    {
        if (s_dirList)
        {
            const char* result = s_dirList(path.c_str());
            if (result)
            {
                std::string dirListStr(result);
                size_t start = 0;
                while (start < dirListStr.size())
                {
                    size_t end = dirListStr.find('\n', start);
                    if (end == std::string::npos)
                        end = dirListStr.size();
                    if (end > start)
                        callback(dirListStr.substr(start, end - start));
                    start = end + 1;
                }
                return true;
            }
        }
        return false;
    }

    bool traverseDirectoryRecursive(const std::string& path, const std::function<void(const std::string& name)>& callback)
    {
        return traverseDirectory(path, callback);
    }

    std::optional<std::string> getCurrentWorkingDirectory()
    {
        if (s_getCurrentDirectory)
        {
            const char* result = s_getCurrentDirectory();
            if (result)
                return std::string(result);
        }
        return std::nullopt;
    }

    bool writeFileIfModified(const std::string& name, const std::string& content)
    {
        return false;
    }
}

#endif // __EMSCRIPTEN__
