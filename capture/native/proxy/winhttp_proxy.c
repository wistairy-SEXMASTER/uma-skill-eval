// winhttp.dll proxy for the local capture tool.
//
// The game loads winhttp.dll from its own directory.  This DLL forwards the
// WinHTTP exports to winhttp_orig.dll (a copy of the system DLL) and starts the
// capture worker in a separate thread.
//
// Keep this file free of game-specific code.  The capture worker lives in
// capture/native/capture and is linked into this DLL by build.ps1.

#include <windows.h>
#include <stdio.h>
#include <wchar.h>

void capture_start(HINSTANCE instance);

static void log_line(const wchar_t* text) {
    wchar_t path[MAX_PATH];
    HMODULE self = NULL;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (LPCWSTR)&log_line,
            &self)) {
        return;
    }
    DWORD len = GetModuleFileNameW(self, path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return;
    wchar_t* slash = wcsrchr(path, L'\\');
    if (!slash) return;
    wcscpy_s(slash + 1, MAX_PATH - (slash + 1 - path), L"winhttp_proxy.log");

    FILE* f = NULL;
    if (_wfopen_s(&f, path, L"a, ccs=UTF-8") == 0 && f) {
        fwprintf(f, L"%s\n", text);
        fclose(f);
    }
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(instance);
        log_line(L"winhttp proxy attached");
        capture_start(instance);
    }
    return TRUE;
}
