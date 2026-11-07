// Minimal DLL injector for the genuine game executable.
//
// Usage:
//   injector.exe <game.exe> <capture.dll> [game args...]
//
// Starts the game suspended, injects the DLL with LoadLibraryW, then resumes.
// It does not modify any file in the game directory.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdbool.h>
#include <stdio.h>
#include <wchar.h>

static void quote_arg(const wchar_t* arg, wchar_t* out, size_t out_count) {
    size_t o = 0;
    if (o + 1 < out_count) out[o++] = L'"';
    for (const wchar_t* p = arg; *p && o + 2 < out_count; p++) {
        if (*p == L'"') {
            if (o + 2 < out_count) out[o++] = L'\\';
            if (o + 2 < out_count) out[o++] = L'"';
        } else {
            out[o++] = *p;
        }
    }
    if (o + 1 < out_count) out[o++] = L'"';
    out[o] = L'\0';
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 3) {
        wprintf(L"usage: injector.exe <game.exe> <capture.dll> [game args...]\n");
        wprintf(L"       injector.exe --pid <pid> <capture.dll>\n");
        return 1;
    }

    bool inject_pid = false;
    DWORD target_pid = 0;
    const wchar_t* dll_arg = NULL;
    int arg_start = 3;

    if (wcscmp(argv[1], L"--pid") == 0) {
        if (argc < 4) {
            wprintf(L"usage: injector.exe --pid <pid> <capture.dll>\n");
            return 1;
        }
        target_pid = (DWORD)wcstoul(argv[2], NULL, 10);
        dll_arg = argv[3];
        inject_pid = true;
    } else {
        dll_arg = argv[2];
    }

    wchar_t dll_path[MAX_PATH];
    if (!GetFullPathNameW(dll_arg, MAX_PATH, dll_path, NULL)) {
        wprintf(L"GetFullPathNameW(dll) failed: %lu\n", GetLastError());
        return 1;
    }

    if (inject_pid) {
        HANDLE process = OpenProcess(
            PROCESS_CREATE_THREAD | PROCESS_QUERY_INFORMATION | PROCESS_VM_OPERATION |
            PROCESS_VM_WRITE | PROCESS_VM_READ,
            FALSE, target_pid);
        if (!process) {
            wprintf(L"OpenProcess(%lu) failed: %lu\n", target_pid, GetLastError());
            return 1;
        }
        wprintf(L"target pid=%lu\n", target_pid);
        size_t dll_bytes = (wcslen(dll_path) + 1) * sizeof(wchar_t);
        void* remote = VirtualAllocEx(process, NULL, dll_bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
        if (!remote) {
            wprintf(L"VirtualAllocEx failed: %lu\n", GetLastError());
            CloseHandle(process);
            return 1;
        }
        if (!WriteProcessMemory(process, remote, dll_path, dll_bytes, NULL)) {
            wprintf(L"WriteProcessMemory failed: %lu\n", GetLastError());
            CloseHandle(process);
            return 1;
        }
        HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
        LPTHREAD_START_ROUTINE load_library =
            (LPTHREAD_START_ROUTINE)GetProcAddress(kernel32, "LoadLibraryW");
        HANDLE thread = CreateRemoteThread(process, NULL, 0, load_library, remote, 0, NULL);
        if (!thread) {
            wprintf(L"CreateRemoteThread failed: %lu\n", GetLastError());
            CloseHandle(process);
            return 1;
        }
        DWORD wait = WaitForSingleObject(thread, 15000);
        DWORD remote_result = 0;
        if (wait == WAIT_OBJECT_0) GetExitCodeThread(thread, &remote_result);
        wprintf(L"LoadLibraryW thread wait=%lu result=%lu\n", wait, remote_result);
        CloseHandle(thread);
        CloseHandle(process);
        return 0;
    }

    wchar_t exe_path[MAX_PATH];
    if (!GetFullPathNameW(argv[1], MAX_PATH, exe_path, NULL)) {
        wprintf(L"GetFullPathNameW(exe) failed: %lu\n", GetLastError());
        return 1;
    }

    wchar_t cmdline[32768];
    cmdline[0] = L'\0';
    wcscat_s(cmdline, 32768, L"\"");
    wcscat_s(cmdline, 32768, exe_path);
    wcscat_s(cmdline, 32768, L"\"");
    for (int i = 3; i < argc; i++) {
        wchar_t quoted[4096];
        quote_arg(argv[i], quoted, 4096);
        wcscat_s(cmdline, 32768, L" ");
        wcscat_s(cmdline, 32768, quoted);
    }

    wchar_t workdir[MAX_PATH];
    wcscpy_s(workdir, MAX_PATH, exe_path);
    wchar_t* slash = wcsrchr(workdir, L'\\');
    if (slash) *slash = L'\0';

    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));

    wprintf(L"starting suspended: %s\n", exe_path);
    if (!CreateProcessW(exe_path, cmdline, NULL, NULL, FALSE, CREATE_SUSPENDED, NULL, workdir, &si, &pi)) {
        wprintf(L"CreateProcessW failed: %lu\n", GetLastError());
        return 1;
    }
    wprintf(L"pid=%lu\n", pi.dwProcessId);

    size_t dll_bytes = (wcslen(dll_path) + 1) * sizeof(wchar_t);
    void* remote = VirtualAllocEx(pi.hProcess, NULL, dll_bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    if (!remote) {
        wprintf(L"VirtualAllocEx failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }
    if (!WriteProcessMemory(pi.hProcess, remote, dll_path, dll_bytes, NULL)) {
        wprintf(L"WriteProcessMemory failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }

    HMODULE kernel32 = GetModuleHandleW(L"kernel32.dll");
    LPTHREAD_START_ROUTINE load_library =
        (LPTHREAD_START_ROUTINE)GetProcAddress(kernel32, "LoadLibraryW");
    if (!load_library) {
        wprintf(L"GetProcAddress(LoadLibraryW) failed\n");
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }

    HANDLE thread = CreateRemoteThread(pi.hProcess, NULL, 0, load_library, remote, 0, NULL);
    if (!thread) {
        wprintf(L"CreateRemoteThread failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }
    DWORD wait = WaitForSingleObject(thread, 15000);
    DWORD remote_result = 0;
    if (wait == WAIT_OBJECT_0) {
        GetExitCodeThread(thread, &remote_result);
    }
    wprintf(L"LoadLibraryW thread wait=%lu result=%lu\n", wait, remote_result);
    CloseHandle(thread);

    if (!ResumeThread(pi.hThread)) {
        wprintf(L"ResumeThread failed: %lu\n", GetLastError());
        TerminateProcess(pi.hProcess, 1);
        return 1;
    }
    wprintf(L"resumed\n");

    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return 0;
}
