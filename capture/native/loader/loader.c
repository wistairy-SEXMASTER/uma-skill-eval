// Self-contained loader for the genuine game files.
//
// This starts UnityPlayer.dll!UnityMain directly instead of using the Steam
// DRM launcher or Hachimi's funnyhoney loader.  It optionally loads the local
// capture DLL before Unity starts, so no external injector is needed.
//
// The executable is expected to live in the game directory.  Because Unity
// derives the data directory from the executable name, create a directory
// junction named <loader>_Data -> UmamusumePrettyDerby_Jpn_Data.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <wchar.h>

typedef int(__stdcall* UnityMainFn)(HINSTANCE, HINSTANCE, LPWSTR, int);

static void set_steam_env(void) {
    SetEnvironmentVariableW(L"SteamAppId", L"3564400");
    SetEnvironmentVariableW(L"SteamGameId", L"3564400");
}

int wmain(int argc, wchar_t** argv) {
    (void)argc;
    (void)argv;

    wchar_t dir[MAX_PATH];
    DWORD len = GetModuleFileNameW(NULL, dir, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) {
        wprintf(L"GetModuleFileNameW failed: %lu\n", GetLastError());
        return 1;
    }
    wchar_t* slash = wcsrchr(dir, L'\\');
    if (!slash) return 1;
    *slash = L'\0';
    SetCurrentDirectoryW(dir);

    set_steam_env();

    wchar_t capture[MAX_PATH];
    wcscpy_s(capture, MAX_PATH, dir);
    wcscat_s(capture, MAX_PATH, L"\\uma_capture.dll");
    HMODULE cap = LoadLibraryW(capture);
    if (!cap) {
        wprintf(L"capture DLL load failed: %lu (%s)\n", GetLastError(), capture);
    } else {
        wprintf(L"capture DLL loaded: %s\n", capture);
    }

    wchar_t unity[MAX_PATH];
    wcscpy_s(unity, MAX_PATH, dir);
    wcscat_s(unity, MAX_PATH, L"\\UnityPlayer.dll");
    HMODULE up = LoadLibraryW(unity);
    if (!up) {
        wprintf(L"UnityPlayer.dll load failed: %lu (%s)\n", GetLastError(), unity);
        return 1;
    }

    UnityMainFn unity_main = (UnityMainFn)GetProcAddress(up, "UnityMain");
    if (!unity_main) {
        wprintf(L"UnityMain not found in %s\n", unity);
        return 1;
    }

    wprintf(L"calling UnityMain\n");
    return unity_main(GetModuleHandleW(NULL), NULL, GetCommandLineW(), SW_SHOW);
}
