#pragma once

#include "Transport.hpp"
#include <string>
#include <mutex>

class WasmTransport : public Transport
{
private:
    mutable std::mutex responseMutex;
    std::string lastResponse;

public:
    void send(const std::string& data) override
    {
        std::lock_guard guard(responseMutex);
        lastResponse = data;
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
        std::string result = std::move(lastResponse);
        lastResponse.clear();
        return result;
    }
};
