#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>

#include <winhttp.h>
#include <mmdeviceapi.h>
#include <endpointvolume.h>
#include <string>
#include <iostream>
#include <sstream>
#include <winrt/Windows.Media.Control.h>
#include <winrt/Windows.Storage.Streams.h>
#include <winrt/Windows.Foundation.h>
#include <thread>
#include <chrono>
#include <atomic>
#include <vector>

#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "crypt32.lib")
#pragma comment(lib, "windowsapp.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ws2_32.lib")

using namespace winrt;
using namespace Windows::Media::Control;
using namespace Windows::Storage::Streams;
using namespace Windows::Foundation;

const int PORT = 1488;
const int CMD_PORT = 1490;
const int STEP = 5;
int currentVolume = 0;
bool currentMute = false;

IAudioEndpointVolume* pEndpointVolume = nullptr;
HHOOK hKeyboardHook = nullptr;
std::string cachedMediaJson;
std::atomic<bool> running(true);

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam);
bool InitAudio();
void ChangeVolume(bool up);
void ToggleMute();
void SendVolumeAndCachedMedia();
std::string GetMediaText();
std::string GetPlaybackStatusStr();
void TryUpdateMedia();
void MediaUpdateLoop();
void CommandServer();
void DisableVolumeOSD();
void EnableVolumeOSD();
void SendMediaCommand(const std::wstring& command);

int main()
{
    CoInitialize(nullptr);

    DisableVolumeOSD();
    atexit(EnableVolumeOSD);

    std::thread cmdThread(CommandServer);

    if (!InitAudio())
    {
        std::cerr << "Failed to initialize audio endpoint" << std::endl;
        CoUninitialize();
        return 1;
    }

    float level;
    if (SUCCEEDED(pEndpointVolume->GetMasterVolumeLevelScalar(&level)))
        currentVolume = static_cast<int>(level * 100 + 0.5);

    BOOL muteState = FALSE;
    if (SUCCEEDED(pEndpointVolume->GetMute(&muteState)))
        currentMute = muteState;

    std::cout << "LOverlay C++ listener started." << std::endl;
    SendVolumeAndCachedMedia();

    hKeyboardHook = SetWindowsHookEx(WH_KEYBOARD_LL, LowLevelKeyboardProc,
        GetModuleHandle(nullptr), 0);
    if (!hKeyboardHook)
    {
        std::cerr << "Failed to set keyboard hook. Run as Administrator." << std::endl;
        pEndpointVolume->Release();
        CoUninitialize();
        return 1;
    }

    std::cout << "Listening for volume keys... (System OSD disabled)" << std::endl;

    std::thread mediaThread(MediaUpdateLoop);

    MSG msg;
    while (GetMessage(&msg, nullptr, 0, 0))
    {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    running = false;
    if (mediaThread.joinable()) mediaThread.join();
    if (cmdThread.joinable()) cmdThread.join();

    UnhookWindowsHookEx(hKeyboardHook);
    pEndpointVolume->Release();
    CoUninitialize();
    return 0;
}

bool InitAudio()
{
    IMMDeviceEnumerator* pEnumerator = nullptr;
    IMMDevice* pDevice = nullptr;

    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator);
    if (FAILED(hr)) return false;

    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    pEnumerator->Release();
    if (FAILED(hr)) return false;

    hr = pDevice->Activate(__uuidof(IAudioEndpointVolume), CLSCTX_ALL, nullptr,
        (void**)&pEndpointVolume);
    pDevice->Release();
    return SUCCEEDED(hr);
}

void ChangeVolume(bool up)
{
    if (!pEndpointVolume) return;
    if (up) currentVolume = min(100, currentVolume + STEP);
    else    currentVolume = max(0, currentVolume - STEP);
    pEndpointVolume->SetMasterVolumeLevelScalar(currentVolume / 100.0f, nullptr);
    TryUpdateMedia();
    SendVolumeAndCachedMedia();
}

void ToggleMute()
{
    if (!pEndpointVolume) return;
    BOOL mute = FALSE;
    if (SUCCEEDED(pEndpointVolume->GetMute(&mute)))
    {
        pEndpointVolume->SetMute(!mute, nullptr);
        currentMute = !mute;
    }
    else
    {
        currentMute = !currentMute;
        pEndpointVolume->SetMute(currentMute, nullptr);
    }
    SendVolumeAndCachedMedia();
}

std::string GetMediaText()
{
    try
    {
        auto asyncOp = GlobalSystemMediaTransportControlsSessionManager::RequestAsync();
        auto sessionManager = asyncOp.get();
        auto session = sessionManager.GetCurrentSession();
        if (!session) return "";

        auto propsOp = session.TryGetMediaPropertiesAsync();
        auto properties = propsOp.get();
        if (!properties) return "";

        std::string title = winrt::to_string(properties.Title());
        std::string artist = winrt::to_string(properties.Artist());

        std::ostringstream json;
        json << "{\"title\":\"" << title << "\",\"artist\":\"" << artist << "\",\"thumbnail\":\"\"}";
        return json.str();
    }
    catch (...)
    {
        return "";
    }
}

std::string GetPlaybackStatusStr()
{
    try
    {
        auto asyncOp = GlobalSystemMediaTransportControlsSessionManager::RequestAsync();
        auto sessionManager = asyncOp.get();
        auto session = sessionManager.GetCurrentSession();
        if (!session) return "Closed";

        auto info = session.GetPlaybackInfo();
        auto status = info.PlaybackStatus();
        switch (status)
        {
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing:
            return "Playing";
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Paused:
            return "Paused";
        case GlobalSystemMediaTransportControlsSessionPlaybackStatus::Stopped:
            return "Stopped";
        default:
            return "Closed";
        }
    }
    catch (...)
    {
        return "Closed";
    }
}

void TryUpdateMedia()
{
    std::string newMedia = GetMediaText();
    if (!newMedia.empty() && newMedia != cachedMediaJson)
    {
        cachedMediaJson = newMedia;
        std::cout << "[Media] Text updated: " << cachedMediaJson << std::endl;
        SendVolumeAndCachedMedia();
    }
}

void MediaUpdateLoop()
{
    while (running)
    {
        TryUpdateMedia();
        std::this_thread::sleep_for(std::chrono::milliseconds(1500));
    }
}

void SendVolumeAndCachedMedia()
{
    std::string json;
    std::string mediaPart;
    std::string playbackStatus = GetPlaybackStatusStr();

    if (cachedMediaJson.empty())
        mediaPart = "\"title\":\"\",\"artist\":\"\",\"thumbnail\":null";
    else
        mediaPart = cachedMediaJson.substr(1, cachedMediaJson.length() - 2);

    std::ostringstream oss;
    oss << "{" << mediaPart
        << ",\"volume\":" << currentVolume
        << ",\"muted\":" << (currentMute ? "true" : "false")
        << ",\"playbackStatus\":\"" << playbackStatus << "\""
        << "}";
    json = oss.str();

    HINTERNET hSession = WinHttpOpen(L"LOverlay/1.0", WINHTTP_ACCESS_TYPE_DEFAULT_PROXY,
        WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hSession) return;
    HINTERNET hConnect = WinHttpConnect(hSession, L"127.0.0.1", PORT, 0);
    if (!hConnect) { WinHttpCloseHandle(hSession); return; }
    HINTERNET hRequest = WinHttpOpenRequest(hConnect, L"POST", L"/update", nullptr,
        WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0);
    if (!hRequest) { WinHttpCloseHandle(hConnect); WinHttpCloseHandle(hSession); return; }
    std::wstring headers = L"Content-Type: application/json\r\n";
    BOOL result = WinHttpSendRequest(hRequest, headers.c_str(), (DWORD)headers.length(),
        (LPVOID)json.c_str(), (DWORD)json.length(),
        (DWORD)json.length(), 0);
    if (result) {
        WinHttpReceiveResponse(hRequest, nullptr);
        std::cout << "Sent: " << json << std::endl;
    }
    else {
        std::cerr << "Send error: " << GetLastError() << std::endl;
    }
    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
}

void SetOSDPolicy(bool disableOSD)
{
    HKEY hKey;
    if (RegOpenKeyEx(HKEY_CURRENT_USER,
        L"Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer",
        0, KEY_SET_VALUE, &hKey) == ERROR_SUCCESS)
    {
        if (disableOSD)
        {
            DWORD value = 1;
            RegSetValueEx(hKey, L"NoHardwareMediaKeys", 0, REG_DWORD, (BYTE*)&value, sizeof(value));
        }
        else
        {
            RegDeleteValue(hKey, L"NoHardwareMediaKeys");
        }
        RegCloseKey(hKey);

        SendNotifyMessage(HWND_BROADCAST, WM_SETTINGCHANGE, 0, (LPARAM)L"Policy");
    }
}

void DisableVolumeOSD()
{
    SetOSDPolicy(true);
    std::cout << "System volume OSD disabled." << std::endl;
}

void EnableVolumeOSD()
{
    SetOSDPolicy(false);
    std::cout << "System volume OSD restored." << std::endl;
}

void SendMediaCommand(const std::wstring& command)
{
    try
    {
        auto asyncOp = GlobalSystemMediaTransportControlsSessionManager::RequestAsync();
        auto sessionManager = asyncOp.get();
        auto session = sessionManager.GetCurrentSession();
        if (!session)
        {
            std::cout << "No active media session." << std::endl;
            return;
        }

        if (command == L"playpause")
        {
            if (session.GetPlaybackInfo().PlaybackStatus() ==
                GlobalSystemMediaTransportControlsSessionPlaybackStatus::Playing)
                session.TryPauseAsync();
            else
                session.TryPlayAsync();
        }
        else if (command == L"next")
            session.TrySkipNextAsync();
        else if (command == L"previous")
            session.TrySkipPreviousAsync();
    }
    catch (const std::exception& e)
    {
        std::cerr << "Media command error: " << e.what() << std::endl;
    }
}

void CommandServer()
{
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);

    SOCKET serverSocket = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (serverSocket == INVALID_SOCKET) return;

    sockaddr_in serverAddr = {};
    serverAddr.sin_family = AF_INET;
    serverAddr.sin_port = htons(CMD_PORT);
    inet_pton(AF_INET, "127.0.0.1", &serverAddr.sin_addr);

    if (bind(serverSocket, (sockaddr*)&serverAddr, sizeof(serverAddr)) == SOCKET_ERROR)
    {
        closesocket(serverSocket);
        WSACleanup();
        return;
    }
    listen(serverSocket, SOMAXCONN);

    while (running)
    {
        SOCKET clientSocket = accept(serverSocket, nullptr, nullptr);
        if (clientSocket == INVALID_SOCKET) continue;

        char buffer[64] = {};
        recv(clientSocket, buffer, sizeof(buffer), 0);
        std::string cmd(buffer);
        closesocket(clientSocket);

        if (!cmd.empty() && cmd.back() == '\n') cmd.pop_back();
        if (!cmd.empty() && cmd.back() == '\r') cmd.pop_back();

        std::wstring wcmd(cmd.begin(), cmd.end());
        SendMediaCommand(wcmd);

        SendVolumeAndCachedMedia();
    }

    closesocket(serverSocket);
    WSACleanup();
}

LRESULT CALLBACK LowLevelKeyboardProc(int nCode, WPARAM wParam, LPARAM lParam)
{
    if (nCode == HC_ACTION)
    {
        KBDLLHOOKSTRUCT* pKb = (KBDLLHOOKSTRUCT*)lParam;
        if (wParam == WM_KEYDOWN)
        {
            if (pKb->vkCode == VK_VOLUME_UP)
            {
                ChangeVolume(true);
                return 1;
            }
            else if (pKb->vkCode == VK_VOLUME_DOWN)
            {
                ChangeVolume(false);
                return 1;
            }
            else if (pKb->vkCode == VK_VOLUME_MUTE)
            {
                ToggleMute();
                return 1;
            }
            else if (pKb->vkCode == VK_MEDIA_PLAY_PAUSE ||
                pKb->vkCode == VK_MEDIA_NEXT_TRACK ||
                pKb->vkCode == VK_MEDIA_PREV_TRACK)
            {
                return 1;
            }
        }
    }
    return CallNextHookEx(hKeyboardHook, nCode, wParam, lParam);
}