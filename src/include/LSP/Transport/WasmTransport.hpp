#pragma once

#include "Transport.hpp"
#include <string>
#include <mutex>
#include <queue>

class WasmTransport : public Transport
{
private:
    mutable std::mutex responseMutex;
    std::queue<std::string> responses;

public:
    void send(const std::string& data) override
    {
        std::lock_guard guard(responseMutex);
        responses.push(data);
    }

    void read(char* buffer, unsigned int length) override
    {
    }

    bool readLine(std::string& output) override
    {
        return false;
    }

    std::string getAndClearResponse()
    {
        std::lock_guard guard(responseMutex);
        if (responses.empty())
            return {};
        std::string result = std::move(responses.front());
        responses.pop();
        return result;
    }
};
