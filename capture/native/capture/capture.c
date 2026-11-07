// Standalone capture DLL for the local skill viewer.
//
// This is a minimal reimplementation of the parts of Hachimi-Edge's
// hachimi-httpforward-plugin that we need:
//
//   Cute.Http.HttpHelper.CompressRequest(byte[])
//   Cute.Http.HttpHelper.DecompressResponse(byte[])
//   Cute.Http.WWWRequest.Post(string, byte[], Dictionary)
//   Cute.Http.WWWRequest.get_bytes()
//   Cute.Http.WWWRequest.Dispose()
//
// The plaintext request/response bodies are sent to capture/server.py at
// 127.0.0.1:4693 with the same /notify/request and /notify/response contract
// that the Python server already understands.
//
// The DLL is loaded through the local winhttp.dll proxy.  It waits for
// GameAssembly.dll, resolves the obfuscated IL2CPP API names from
// UnityPlayer.dll, installs MinHook hooks, and forwards copies of the bodies.
// No Hachimi or URA component is required.

#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

#include "MinHook.h"
#include "il2cpp_symbols.h"

#define CAPTURE_HOST "127.0.0.1"
#define CAPTURE_PORT 4693
#define MAX_PENDING 64
#define MAX_ACTIVE 64
#define ARRAY_HEADER_SIZE 0x20

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

static CRITICAL_SECTION g_log_lock;
static bool g_log_lock_ready = false;

static void log_msg(const char* fmt, ...) {
    if (!g_log_lock_ready) return;
    EnterCriticalSection(&g_log_lock);
    wchar_t path[MAX_PATH];
    HMODULE self = NULL;
    if (GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (LPCWSTR)&log_msg, &self)) {
        DWORD len = GetModuleFileNameW(self, path, MAX_PATH);
        if (len > 0 && len < MAX_PATH) {
            wchar_t* slash = wcsrchr(path, L'\\');
            if (slash) {
                wcscpy_s(slash + 1, MAX_PATH - (slash + 1 - path), L"uma_capture.log");
                FILE* f = NULL;
                if (_wfopen_s(&f, path, L"a") == 0 && f) {
                    va_list ap;
                    va_start(ap, fmt);
                    vfprintf(f, fmt, ap);
                    va_end(ap);
                    fputc('\n', f);
                    fclose(f);
                }
            }
        }
    }
    LeaveCriticalSection(&g_log_lock);
}

// ---------------------------------------------------------------------------
// metadata capture
// ---------------------------------------------------------------------------

// The game's IL2CPP metadata is not present as global-metadata.dat on disk.
// It is decrypted into the .data section of GameAssembly.dll at startup.
// Hook the common copy/read functions and dump any large copy whose
// destination is inside that section.

static uintptr_t g_ga_base = 0;
static uintptr_t g_ga_data_start = 0;
static uintptr_t g_ga_data_end = 0;
static volatile LONG g_meta_dump_index = 0;
static __thread int t_in_meta_hook = 0;

USHORT WINAPI RtlCaptureStackBackTrace(ULONG FramesToSkip, ULONG FramesToCapture,
                                       PVOID* BackTrace, PULONG BackTraceHash);

static void dll_dir(wchar_t* out, size_t out_count) {
    HMODULE self = NULL;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            (LPCWSTR)&dll_dir, &self)) {
        out[0] = L'\0';
        return;
    }
    DWORD len = GetModuleFileNameW(self, out, (DWORD)out_count);
    if (len == 0 || len >= out_count) {
        out[0] = L'\0';
        return;
    }
    wchar_t* slash = wcsrchr(out, L'\\');
    if (slash) *slash = L'\0';
}

static void ensure_ga_data_range(void) {
    if (g_ga_data_start) return;
    HMODULE ga = GetModuleHandleW(L"GameAssembly.dll");
    if (!ga) return;
    g_ga_base = (uintptr_t)ga;
    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)ga;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return;
    IMAGE_NT_HEADERS64* nt = (IMAGE_NT_HEADERS64*)((uint8_t*)ga + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return;
    IMAGE_SECTION_HEADER* sec = IMAGE_FIRST_SECTION(nt);
    for (WORD i = 0; i < nt->FileHeader.NumberOfSections; i++) {
        if (memcmp(sec[i].Name, ".data", 5) == 0) {
            g_ga_data_start = g_ga_base + sec[i].VirtualAddress;
            g_ga_data_end = g_ga_data_start + sec[i].Misc.VirtualSize;
            break;
        }
    }
}

static void dump_meta(const char* tag, const void* src, size_t n) {
    if (!src || n == 0 || n > 64 * 1024 * 1024) return;
    wchar_t dir[MAX_PATH];
    dll_dir(dir, MAX_PATH);
    if (!dir[0]) return;
    LONG index = InterlockedIncrement(&g_meta_dump_index);
    wchar_t path[MAX_PATH];
    _snwprintf_s(path, MAX_PATH, _TRUNCATE, L"%s\\metadata_%hs_%ld.bin", dir, tag, (long)index);
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) {
        log_msg("metadata dump open failed: %lu", GetLastError());
        return;
    }
    DWORD written = 0;
    const uint8_t* p = (const uint8_t*)src;
    size_t left = n;
    while (left > 0) {
        DWORD chunk = (left > 1 << 20) ? (1 << 20) : (DWORD)left;
        if (!WriteFile(file, p, chunk, &written, NULL) || written != chunk) break;
        p += written;
        left -= written;
    }
    CloseHandle(file);
    log_msg("metadata dump %s -> %s (%zu bytes)", tag, path, n);
}

typedef void* (*memcpy_fn)(void*, const void*, size_t);
typedef void* (*memmove_fn)(void*, const void*, size_t);
typedef BOOL (WINAPI* readfile_fn)(HANDLE, LPVOID, DWORD, LPDWORD, LPOVERLAPPED);

static memcpy_fn g_orig_memcpy = NULL;
static memmove_fn g_orig_memmove = NULL;
static readfile_fn g_orig_readfile = NULL;

static bool dest_in_data(const void* dest, size_t n) {
    ensure_ga_data_range();
    if (!g_ga_data_start) return false;
    uintptr_t d = (uintptr_t)dest;
    return d >= g_ga_data_start && d < g_ga_data_end && n >= 4096;
}

static void* hook_memcpy(void* dest, const void* src, size_t n) {
    if (!t_in_meta_hook && dest_in_data(dest, n)) {
        t_in_meta_hook = 1;
        log_msg("meta memcpy dest=%p src=%p size=%zu", dest, src, n);
        dump_meta("memcpy", src, n);
        t_in_meta_hook = 0;
    }
    return g_orig_memcpy(dest, src, n);
}

static void* hook_memmove(void* dest, const void* src, size_t n) {
    if (!t_in_meta_hook && dest_in_data(dest, n)) {
        t_in_meta_hook = 1;
        log_msg("meta memmove dest=%p src=%p size=%zu", dest, src, n);
        dump_meta("memmove", src, n);
        t_in_meta_hook = 0;
    }
    return g_orig_memmove(dest, src, n);
}

static BOOL WINAPI hook_readfile(HANDLE file, LPVOID buffer, DWORD bytes,
                                 LPDWORD read, LPOVERLAPPED overlapped) {
    BOOL ok = g_orig_readfile(file, buffer, bytes, read, overlapped);
    if (ok && read && *read >= 4096 && !t_in_meta_hook) {
        t_in_meta_hook = 1;
        log_msg("meta ReadFile size=%lu", (unsigned long)*read);
        dump_meta("readfile", buffer, *read);
        t_in_meta_hook = 0;
    }
    return ok;
}

static void install_one(const wchar_t* dll, const char* name, void* hook, void** original) {
    HMODULE module = GetModuleHandleW(dll);
    if (!module) module = LoadLibraryW(dll);
    if (!module) {
        log_msg("metadata hook module missing: %s", name);
        return;
    }
    void* target = (void*)GetProcAddress(module, name);
    if (!target) {
        log_msg("metadata hook target missing: %s", name);
        return;
    }
    MH_STATUS st = MH_CreateHook(target, hook, original);
    if (st != MH_OK) {
        log_msg("metadata hook create %s failed: %d", name, (int)st);
        return;
    }
    if (!original || !*original) {
        log_msg("metadata hook original null: %s", name);
        return;
    }
    st = MH_EnableHook(target);
    if (st != MH_OK && st != MH_ERROR_ENABLED) {
        log_msg("metadata hook enable %s failed: %d", name, (int)st);
        return;
    }
    log_msg("metadata hook installed: %s at %p", name, target);
}

static HMODULE WINAPI hook_loadlibraryw(LPCWSTR name);
static HMODULE WINAPI hook_loadlibraryexw(LPCWSTR name, HANDLE file, DWORD flags);
static LONG CALLBACK data_guard_handler(EXCEPTION_POINTERS* info);

typedef struct {
    USHORT Length;
    USHORT MaximumLength;
    PWSTR Buffer;
} MY_UNICODE_STRING;

typedef struct {
    ULONG Flags;
    const MY_UNICODE_STRING* FullDllName;
    const MY_UNICODE_STRING* BaseDllName;
    PVOID DllBase;
    ULONG SizeOfImage;
} MY_LDR_DLL_NOTIFICATION_DATA;

typedef VOID (CALLBACK* PLDR_DLL_NOTIFICATION_FUNCTION)(
    ULONG reason, const MY_LDR_DLL_NOTIFICATION_DATA* data, PVOID context);
typedef LONG (NTAPI* LdrRegisterDllNotification_fn)(
    ULONG flags, PLDR_DLL_NOTIFICATION_FUNCTION callback, PVOID context, PVOID* cookie);

static volatile LONG g_guard_count = 0;
static bool g_guard_installed = false;
static volatile LONG g_notification_seen = 0;
static volatile LONG g_notification_armed = 0;

static void arm_data_guard(void);

static VOID CALLBACK dll_notification(ULONG reason,
                                      const MY_LDR_DLL_NOTIFICATION_DATA* data,
                                      PVOID context) {
    (void)context;
    if (reason != 1 || !data || !data->BaseDllName || !data->BaseDllName->Buffer) return;
    USHORT chars = data->BaseDllName->Length / sizeof(WCHAR);
    if (chars == 16 && _wcsnicmp(data->BaseDllName->Buffer, L"GameAssembly.dll", 16) == 0) {
        InterlockedIncrement(&g_notification_seen);
        arm_data_guard();
        if (g_guard_installed) InterlockedExchange(&g_notification_armed, 1);
    }
}

typedef HMODULE (WINAPI* LoadLibraryW_fn)(LPCWSTR);
typedef HMODULE (WINAPI* LoadLibraryExW_fn)(LPCWSTR, HANDLE, DWORD);
static LoadLibraryW_fn g_orig_loadlibraryw = NULL;
static LoadLibraryExW_fn g_orig_loadlibraryexw = NULL;

static void arm_data_guard(void) {
    if (g_guard_installed) return;
    ensure_ga_data_range();
    if (!g_ga_data_start) return;
    DWORD old = 0;
    if (VirtualProtect((void*)g_ga_data_start, g_ga_data_end - g_ga_data_start,
                       PAGE_READONLY, &old)) {
        g_guard_installed = true;
    }
}

static HMODULE WINAPI hook_loadlibraryw(LPCWSTR name) {
    HMODULE h = g_orig_loadlibraryw(name);
    if (h && name && (wcsstr(name, L"GameAssembly.dll") || wcsstr(name, L"gameassembly.dll"))) {
        log_msg("GameAssembly.dll loaded via LoadLibraryW: %p", h);
        arm_data_guard();
    }
    return h;
}

static HMODULE WINAPI hook_loadlibraryexw(LPCWSTR name, HANDLE file, DWORD flags) {
    HMODULE h = g_orig_loadlibraryexw(name, file, flags);
    if (h && name && (wcsstr(name, L"GameAssembly.dll") || wcsstr(name, L"gameassembly.dll"))) {
        log_msg("GameAssembly.dll loaded via LoadLibraryExW: %p", h);
        arm_data_guard();
    }
    return h;
}

static LONG CALLBACK data_guard_handler(EXCEPTION_POINTERS* info) {
    if (!info || !info->ExceptionRecord || !info->ContextRecord) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    if (info->ExceptionRecord->ExceptionCode != EXCEPTION_ACCESS_VIOLATION) {
        return EXCEPTION_CONTINUE_SEARCH;
    }
    uintptr_t fault = (uintptr_t)info->ExceptionRecord->ExceptionInformation[1];
    if (!g_ga_data_start || fault < g_ga_data_start || fault >= g_ga_data_end) {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    CONTEXT* ctx = info->ContextRecord;
    uintptr_t rip = (uintptr_t)ctx->Rip;
    uintptr_t rdi = (uintptr_t)ctx->Rdi;
    uintptr_t rsi = (uintptr_t)ctx->Rsi;
    uintptr_t rcx = (uintptr_t)ctx->Rcx;
    LONG count = InterlockedIncrement(&g_guard_count);
    if (count <= 30 || rcx >= 0x100000) {
        uintptr_t dest_off = (rdi >= g_ga_data_start && rdi < g_ga_data_end)
                                 ? (rdi - g_ga_data_start)
                                 : (uintptr_t)-1;
        log_msg("guard fault #%ld addr=%p off=%zx rip=%p rdi=%p rsi=%p rcx=%zx",
                (long)count, (void*)fault, (size_t)(fault - g_ga_data_start),
                (void*)rip, (void*)rdi, (void*)rsi, (size_t)rcx);
        if (dest_off != (uintptr_t)-1) {
            log_msg("  guard dest .data+0x%zx", (size_t)dest_off);
        }
        if (rcx >= 0x100000 || count <= 10) {
            void* stack[16];
            USHORT frames = RtlCaptureStackBackTrace(0, 16, stack, NULL);
            for (USHORT i = 0; i < frames; i++) {
                log_msg("  guard bt[%u]=%p", (unsigned)i, stack[i]);
            }
        }
        if (rcx >= 0x100000 && rsi) {
            dump_meta("guard", (void*)rsi, (size_t)rcx);
        }
    }

    DWORD old = 0;
    void* page = (void*)(fault & ~(uintptr_t)0xFFF);
    if (!VirtualProtect(page, 0x1000, PAGE_READWRITE, &old)) {
        log_msg("guard VirtualProtect failed: %lu", GetLastError());
    }
    return EXCEPTION_CONTINUE_EXECUTION;
}

static DWORD WINAPI data_guard_thread(LPVOID param) {
    (void)param;
    AddVectoredExceptionHandler(1, data_guard_handler);
    for (int i = 0; i < 5000 && !g_guard_installed; i++) {
        arm_data_guard();
        if (!g_guard_installed) Sleep(1);
    }
    if (g_guard_installed) {
        log_msg("data guard armed (%s)", g_notification_armed ? "notification" : "thread");
    } else {
        log_msg("data guard failed to arm");
    }
    return 0;
}

static void install_metadata_hooks(void) {
    log_msg("metadata hooks start");
    AddVectoredExceptionHandler(1, data_guard_handler);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    LdrRegisterDllNotification_fn reg = ntdll
        ? (LdrRegisterDllNotification_fn)GetProcAddress(ntdll, "LdrRegisterDllNotification")
        : NULL;
    if (reg) {
        PVOID cookie = NULL;
        LONG status = reg(0, dll_notification, NULL, &cookie);
        log_msg("LdrRegisterDllNotification status=%ld cookie=%p", (long)status, cookie);
    } else {
        log_msg("LdrRegisterDllNotification not available");
    }
    CreateThread(NULL, 0, data_guard_thread, NULL, 0, NULL);
    log_msg("metadata hooks done");
}

// ---------------------------------------------------------------------------
// IL2CPP API
// ---------------------------------------------------------------------------

typedef void* Il2CppDomain;
typedef void* Il2CppAssembly;
typedef void* Il2CppImage;
typedef void* Il2CppClass;
typedef void* MethodInfo;
typedef void* Il2CppObject;
typedef void* Il2CppString;
typedef void* Il2CppArray;
typedef void* Il2CppThread;

static HMODULE g_game_assembly;
static Il2CppDomain g_domain;

static Il2CppDomain (*p_il2cpp_domain_get)(void);
static Il2CppAssembly (*p_il2cpp_domain_assembly_open)(Il2CppDomain, const char*);
static Il2CppImage (*p_il2cpp_assembly_get_image)(Il2CppAssembly);
static Il2CppClass (*p_il2cpp_class_from_name)(Il2CppImage, const char*, const char*);
static const MethodInfo* (*p_il2cpp_class_get_method_from_name)(Il2CppClass, const char*, int);
static Il2CppClass (*p_il2cpp_object_get_class)(Il2CppObject);
static bool (*p_il2cpp_class_is_valuetype)(Il2CppClass);
static void* (*p_il2cpp_object_unbox)(Il2CppObject);
static Il2CppObject* (*p_il2cpp_runtime_invoke)(const MethodInfo*, void*, void**, Il2CppObject**);
static int32_t (*p_il2cpp_string_length)(Il2CppString);
static uint16_t* (*p_il2cpp_string_chars)(Il2CppString);
static uint32_t (*p_il2cpp_gchandle_new)(Il2CppObject, bool);
static Il2CppObject* (*p_il2cpp_gchandle_get_target)(uint32_t);
static void (*p_il2cpp_gchandle_free)(uint32_t);
static Il2CppThread (*p_il2cpp_thread_attach)(Il2CppDomain);
static void (*p_il2cpp_thread_detach)(Il2CppThread);

// UnityPlayer.dll's obfuscated export table.  Hachimi-Edge reads this table
// with the same START_RVA / stride; see symbols_impl.rs.
#define SYMBOL_TABLE_START_RVA 0x782c92u
#define SYMBOL_TABLE_FIRST_STRIDE 0x28u
#define SYMBOL_TABLE_STRIDE 0x26u

static uint8_t* g_unityplayer = NULL;
static size_t g_unityplayer_size = 0;
static IMAGE_NT_HEADERS64* g_up_nt = NULL;
static IMAGE_SECTION_HEADER* g_up_sections = NULL;

static bool read_unityplayer(void) {
    wchar_t path[MAX_PATH];
    DWORD len = GetModuleFileNameW(NULL, path, MAX_PATH);
    if (len == 0 || len >= MAX_PATH) return false;
    wchar_t* slash = wcsrchr(path, L'\\');
    if (!slash) return false;
    wcscpy_s(slash + 1, MAX_PATH - (slash + 1 - path), L"UnityPlayer.dll");

    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                              NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file == INVALID_HANDLE_VALUE) return false;
    LARGE_INTEGER size;
    if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > (LONGLONG)(256 * 1024 * 1024)) {
        CloseHandle(file);
        return false;
    }
    g_unityplayer_size = (size_t)size.QuadPart;
    g_unityplayer = (uint8_t*)malloc(g_unityplayer_size);
    if (!g_unityplayer) { CloseHandle(file); return false; }
    DWORD read = 0;
    BOOL ok = ReadFile(file, g_unityplayer, (DWORD)g_unityplayer_size, &read, NULL);
    CloseHandle(file);
    if (!ok || read != g_unityplayer_size) {
        free(g_unityplayer);
        g_unityplayer = NULL;
        return false;
    }

    IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)g_unityplayer;
    if (dos->e_magic != IMAGE_DOS_SIGNATURE) return false;
    IMAGE_NT_HEADERS64* nt = (IMAGE_NT_HEADERS64*)(g_unityplayer + dos->e_lfanew);
    if (nt->Signature != IMAGE_NT_SIGNATURE) return false;
    g_up_nt = nt;
    g_up_sections = IMAGE_FIRST_SECTION(nt);
    return true;
}

static size_t rva_to_offset(uint32_t rva) {
    if (!g_up_nt) return 0;
    for (WORD i = 0; i < g_up_nt->FileHeader.NumberOfSections; i++) {
        IMAGE_SECTION_HEADER* s = &g_up_sections[i];
        uint32_t span = s->Misc.VirtualSize > s->SizeOfRawData ? s->Misc.VirtualSize : s->SizeOfRawData;
        if (rva >= s->VirtualAddress && rva < s->VirtualAddress + span) {
            return s->PointerToRawData + (rva - s->VirtualAddress);
        }
    }
    return 0;
}

static char* obfuscated_name_for(const char* api_name) {
    int index = -1;
    for (int i = 0; i < IL2CPP_SYMBOL_COUNT; i++) {
        if (strcmp(IL2CPP_SYMBOL_LIST[i], api_name) == 0) {
            index = i;
            break;
        }
    }
    if (index < 0) return NULL;

    uint32_t rva = SYMBOL_TABLE_START_RVA;
    for (int i = 0; i < index; i++) {
        rva += (i == 0) ? SYMBOL_TABLE_FIRST_STRIDE : SYMBOL_TABLE_STRIDE;
    }
    size_t off = rva_to_offset(rva);
    if (!off || off + 4 > g_unityplayer_size) return NULL;
    int32_t rip = 0;
    memcpy(&rip, g_unityplayer + off, sizeof(rip));
    uint32_t name_rva = (uint32_t)((int64_t)rva + 4 + rip);
    size_t name_off = rva_to_offset(name_rva);
    if (!name_off || name_off >= g_unityplayer_size) return NULL;
    const char* name = (const char*)(g_unityplayer + name_off);
    size_t max = g_unityplayer_size - name_off;
    size_t n = strnlen(name, max);
    if (n == 0 || n >= 256) return NULL;
    char* out = (char*)malloc(n + 1);
    if (!out) return NULL;
    memcpy(out, name, n);
    out[n] = '\0';
    return out;
}

static void* resolve_api(const char* name) {
    char* obf = obfuscated_name_for(name);
    if (!obf) {
        log_msg("symbol not in list: %s", name);
        return NULL;
    }
    void* addr = (void*)GetProcAddress(g_game_assembly, obf);
    if (!addr) log_msg("GetProcAddress failed: %s -> %s", name, obf);
    free(obf);
    return addr;
}

static bool resolve_il2cpp_api(void) {
    p_il2cpp_domain_get = (Il2CppDomain (*)(void))resolve_api("il2cpp_domain_get");
    p_il2cpp_domain_assembly_open = (Il2CppAssembly (*)(Il2CppDomain, const char*))resolve_api("il2cpp_domain_assembly_open");
    p_il2cpp_assembly_get_image = (Il2CppImage (*)(Il2CppAssembly))resolve_api("il2cpp_assembly_get_image");
    p_il2cpp_class_from_name = (Il2CppClass (*)(Il2CppImage, const char*, const char*))resolve_api("il2cpp_class_from_name");
    p_il2cpp_class_get_method_from_name = (const MethodInfo* (*)(Il2CppClass, const char*, int))resolve_api("il2cpp_class_get_method_from_name");
    p_il2cpp_object_get_class = (Il2CppClass (*)(Il2CppObject))resolve_api("il2cpp_object_get_class");
    p_il2cpp_class_is_valuetype = (bool (*)(Il2CppClass))resolve_api("il2cpp_class_is_valuetype");
    p_il2cpp_object_unbox = (void* (*)(Il2CppObject))resolve_api("il2cpp_object_unbox");
    p_il2cpp_runtime_invoke = (Il2CppObject* (*)(const MethodInfo*, void*, void**, Il2CppObject**))resolve_api("il2cpp_runtime_invoke");
    p_il2cpp_string_length = (int32_t (*)(Il2CppString))resolve_api("il2cpp_string_length");
    p_il2cpp_string_chars = (uint16_t* (*)(Il2CppString))resolve_api("il2cpp_string_chars");
    p_il2cpp_gchandle_new = (uint32_t (*)(Il2CppObject, bool))resolve_api("il2cpp_gchandle_new");
    p_il2cpp_gchandle_get_target = (Il2CppObject* (*)(uint32_t))resolve_api("il2cpp_gchandle_get_target");
    p_il2cpp_gchandle_free = (void (*)(uint32_t))resolve_api("il2cpp_gchandle_free");
    p_il2cpp_thread_attach = (Il2CppThread (*)(Il2CppDomain))resolve_api("il2cpp_thread_attach");
    p_il2cpp_thread_detach = (void (*)(Il2CppThread))resolve_api("il2cpp_thread_detach");

    return p_il2cpp_domain_get && p_il2cpp_domain_assembly_open && p_il2cpp_assembly_get_image &&
           p_il2cpp_class_from_name && p_il2cpp_class_get_method_from_name &&
           p_il2cpp_object_get_class && p_il2cpp_class_is_valuetype && p_il2cpp_object_unbox &&
           p_il2cpp_runtime_invoke && p_il2cpp_string_length && p_il2cpp_string_chars &&
           p_il2cpp_gchandle_new && p_il2cpp_gchandle_get_target && p_il2cpp_gchandle_free &&
           p_il2cpp_thread_attach && p_il2cpp_thread_detach;
}

static void* method_addr(const MethodInfo* method) {
    if (!method) return NULL;
    return *(void**)method; // MethodInfo.methodPointer is the first field.
}

// ---------------------------------------------------------------------------
// managed helpers
// ---------------------------------------------------------------------------

static uint8_t* array_body(void* arr, size_t* out_len) {
    if (!arr) return NULL;
    uintptr_t len = 0;
    memcpy(&len, (uint8_t*)arr + 0x18, sizeof(len));
    if (len == 0) return NULL;
    *out_len = (size_t)len;
    return (uint8_t*)arr + ARRAY_HEADER_SIZE;
}

static char* read_il2cpp_string(void* str) {
    if (!str) return NULL;
    int32_t len = p_il2cpp_string_length(str);
    if (len <= 0) {
        char* empty = (char*)calloc(1, 1);
        return empty;
    }
    uint16_t* chars = p_il2cpp_string_chars(str);
    if (!chars) return NULL;
    int bytes = WideCharToMultiByte(CP_UTF8, 0, (LPCWCH)chars, len, NULL, 0, NULL, NULL);
    if (bytes <= 0) return NULL;
    char* out = (char*)malloc((size_t)bytes + 1);
    if (!out) return NULL;
    WideCharToMultiByte(CP_UTF8, 0, (LPCWCH)chars, len, out, bytes, NULL, NULL);
    out[bytes] = '\0';
    return out;
}

// ---------------------------------------------------------------------------
// forwarding queue
// ---------------------------------------------------------------------------

typedef struct Job {
    struct Job* next;
    const char* path;
    char* request_id;
    char* url;
    uint8_t* body;
    size_t body_len;
} Job;

static CRITICAL_SECTION g_job_lock;
static bool g_job_lock_ready = false;
static Job* g_job_head = NULL;
static Job* g_job_tail = NULL;
static HANDLE g_job_event = NULL;
static HANDLE g_worker_thread = NULL;
static volatile LONG g_request_counter = 0;

static void make_request_id(char* out, size_t out_size) {
    LONG id = InterlockedIncrement(&g_request_counter);
    snprintf(out, out_size, "uma-%08lx", (unsigned long)id);
}

static void enqueue_job(const char* path, const char* request_id, const char* url,
                        const uint8_t* body, size_t body_len) {
    if (!g_job_lock_ready || !g_job_event) return;
    Job* job = (Job*)calloc(1, sizeof(Job));
    if (!job) return;
    job->path = path;
    job->request_id = _strdup(request_id ? request_id : "");
    job->url = _strdup(url ? url : "");
    if (body && body_len) {
        job->body = (uint8_t*)malloc(body_len);
        if (job->body) {
            memcpy(job->body, body, body_len);
            job->body_len = body_len;
        }
    }
    if (!job->request_id || !job->url) {
        free(job->request_id);
        free(job->url);
        free(job->body);
        free(job);
        return;
    }
    EnterCriticalSection(&g_job_lock);
    if (g_job_tail) g_job_tail->next = job;
    else g_job_head = job;
    g_job_tail = job;
    LeaveCriticalSection(&g_job_lock);
    SetEvent(g_job_event);
}

static int send_all(SOCKET s, const void* data, size_t len) {
    const uint8_t* p = (const uint8_t*)data;
    while (len > 0) {
        int chunk = (len > 1 << 20) ? (1 << 20) : (int)len;
        int sent = send(s, (const char*)p, chunk, 0);
        if (sent <= 0) return -1;
        p += sent;
        len -= (size_t)sent;
    }
    return 0;
}

static void header_encode(const char* src, char* dst, size_t dst_size) {
    static const char hex[] = "0123456789ABCDEF";
    size_t o = 0;
    for (const unsigned char* p = (const unsigned char*)src; *p && o + 4 < dst_size; p++) {
        if (*p >= 0x20 && *p <= 0x7e) {
            dst[o++] = (char)*p;
        } else {
            dst[o++] = '%';
            dst[o++] = hex[*p >> 4];
            dst[o++] = hex[*p & 0x0f];
        }
    }
    dst[o] = '\0';
}

static void http_post(const char* path, const char* request_id, const char* url,
                      const uint8_t* body, size_t body_len) {
    SOCKET s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET) return;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(CAPTURE_PORT);
    inet_pton(AF_INET, CAPTURE_HOST, &addr.sin_addr);
    if (connect(s, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        closesocket(s);
        return;
    }
    char encoded_url[4096];
    header_encode(url ? url : "", encoded_url, sizeof(encoded_url));
    char header[8192];
    int hlen = snprintf(header, sizeof(header),
        "POST %s HTTP/1.1\r\n"
        "Host: " CAPTURE_HOST ":%d\r\n"
        "Content-Type: application/octet-stream\r\n"
        "Content-Length: %zu\r\n"
        "X-Hachimi-Request-Id: %s\r\n"
        "X-Hachimi-Game-Url: %s\r\n"
        "Connection: close\r\n"
        "\r\n",
        path, CAPTURE_PORT, body_len, request_id ? request_id : "", encoded_url);
    if (hlen > 0 && (size_t)hlen < sizeof(header)) {
        if (send_all(s, header, (size_t)hlen) == 0 && body_len > 0) {
            send_all(s, body, body_len);
        }
        char buf[4096];
        while (recv(s, buf, sizeof(buf), 0) > 0) { }
    }
    closesocket(s);
}

static DWORD WINAPI worker_thread(LPVOID param) {
    (void)param;
    WSADATA wsa;
    WSAStartup(MAKEWORD(2, 2), &wsa);
    log_msg("forward worker started");
    for (;;) {
        WaitForSingleObject(g_job_event, INFINITE);
        for (;;) {
            Job* job = NULL;
            EnterCriticalSection(&g_job_lock);
            job = g_job_head;
            if (job) {
                g_job_head = job->next;
                if (!g_job_head) g_job_tail = NULL;
            }
            LeaveCriticalSection(&g_job_lock);
            if (!job) break;
            log_msg("forward %s url=%s id=%s bytes=%zu", job->path, job->url, job->request_id, job->body_len);
            http_post(job->path, job->request_id, job->url, job->body, job->body_len);
            free(job->request_id);
            free(job->url);
            free(job->body);
            free(job);
        }
    }
    return 0;
}

// ---------------------------------------------------------------------------
// pending / active request tracking
// ---------------------------------------------------------------------------

typedef struct PendingRequest {
    uint32_t handle;
    uint8_t* body;
    size_t body_len;
} PendingRequest;

typedef struct ActiveRequest {
    uint32_t owner_handle;
    uint32_t response_handle;
    char* url;
    char* request_id;
} ActiveRequest;

static CRITICAL_SECTION g_pending_lock;
static CRITICAL_SECTION g_active_lock;
static bool g_track_lock_ready = false;
static PendingRequest g_pending[MAX_PENDING];
static int g_pending_count = 0;
static ActiveRequest g_active[MAX_ACTIVE];
static int g_active_count = 0;

static void queue_pending(void* compressed, const uint8_t* body, size_t body_len) {
    if (!compressed || !body || body_len == 0) return;
    uint8_t* copy = (uint8_t*)malloc(body_len);
    if (!copy) return;
    memcpy(copy, body, body_len);
    uint32_t handle = p_il2cpp_gchandle_new(compressed, true);
    if (!handle) {
        free(copy);
        return;
    }
    EnterCriticalSection(&g_pending_lock);
    if (g_pending_count >= MAX_PENDING) {
        PendingRequest dropped = g_pending[0];
        memmove(&g_pending[0], &g_pending[1], sizeof(PendingRequest) * (MAX_PENDING - 1));
        g_pending_count--;
        p_il2cpp_gchandle_free(dropped.handle);
        free(dropped.body);
    }
    g_pending[g_pending_count].handle = handle;
    g_pending[g_pending_count].body = copy;
    g_pending[g_pending_count].body_len = body_len;
    g_pending_count++;
    LeaveCriticalSection(&g_pending_lock);
}

static uint8_t* take_pending(void* compressed, size_t* out_len) {
    if (!compressed) return NULL;
    uint8_t* result = NULL;
    EnterCriticalSection(&g_pending_lock);
    for (int i = 0; i < g_pending_count; i++) {
        void* target = p_il2cpp_gchandle_get_target(g_pending[i].handle);
        if (target == compressed) {
            result = g_pending[i].body;
            *out_len = g_pending[i].body_len;
            p_il2cpp_gchandle_free(g_pending[i].handle);
            g_pending[i] = g_pending[g_pending_count - 1];
            g_pending_count--;
            break;
        }
    }
    LeaveCriticalSection(&g_pending_lock);
    return result;
}

static void store_active(void* owner, const char* url, const char* request_id) {
    if (!owner) return;
    uint32_t handle = p_il2cpp_gchandle_new(owner, true);
    if (!handle) return;
    EnterCriticalSection(&g_active_lock);
    if (g_active_count >= MAX_ACTIVE) {
        ActiveRequest dropped = g_active[0];
        memmove(&g_active[0], &g_active[1], sizeof(ActiveRequest) * (MAX_ACTIVE - 1));
        g_active_count--;
        p_il2cpp_gchandle_free(dropped.owner_handle);
        if (dropped.response_handle) p_il2cpp_gchandle_free(dropped.response_handle);
        free(dropped.url);
        free(dropped.request_id);
    }
    g_active[g_active_count].owner_handle = handle;
    g_active[g_active_count].response_handle = 0;
    g_active[g_active_count].url = _strdup(url ? url : "");
    g_active[g_active_count].request_id = _strdup(request_id ? request_id : "");
    g_active_count++;
    LeaveCriticalSection(&g_active_lock);
}

static void bind_response(void* owner, void* response) {
    if (!owner) return;
    EnterCriticalSection(&g_active_lock);
    for (int i = 0; i < g_active_count; i++) {
        void* target = p_il2cpp_gchandle_get_target(g_active[i].owner_handle);
        if (target == owner) {
            if (g_active[i].response_handle) {
                p_il2cpp_gchandle_free(g_active[i].response_handle);
                g_active[i].response_handle = 0;
            }
            if (response) {
                g_active[i].response_handle = p_il2cpp_gchandle_new(response, true);
            }
            break;
        }
    }
    LeaveCriticalSection(&g_active_lock);
}

static ActiveRequest take_response(void* response, bool* found) {
    ActiveRequest result;
    memset(&result, 0, sizeof(result));
    *found = false;
    if (!response) return result;
    EnterCriticalSection(&g_active_lock);
    for (int i = 0; i < g_active_count; i++) {
        if (!g_active[i].response_handle) continue;
        void* target = p_il2cpp_gchandle_get_target(g_active[i].response_handle);
        if (target == response) {
            result = g_active[i];
            g_active[i] = g_active[g_active_count - 1];
            g_active_count--;
            *found = true;
            break;
        }
    }
    LeaveCriticalSection(&g_active_lock);
    return result;
}

static void remove_active(void* owner) {
    if (!owner) return;
    EnterCriticalSection(&g_active_lock);
    for (int i = 0; i < g_active_count; i++) {
        void* target = p_il2cpp_gchandle_get_target(g_active[i].owner_handle);
        if (target == owner) {
            ActiveRequest dropped = g_active[i];
            g_active[i] = g_active[g_active_count - 1];
            g_active_count--;
            p_il2cpp_gchandle_free(dropped.owner_handle);
            if (dropped.response_handle) p_il2cpp_gchandle_free(dropped.response_handle);
            free(dropped.url);
            free(dropped.request_id);
            break;
        }
    }
    LeaveCriticalSection(&g_active_lock);
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

typedef void* (*CompressRequestFn)(void*, void*);
typedef void* (*DecompressResponseFn)(void*, void*);
typedef void (*WwwPostFn)(void*, void*, void*, void*, void*);
typedef void* (*WwwGetBytesFn)(void*, void*);
typedef void (*WwwDisposeFn)(void*, void*);

static CompressRequestFn g_orig_compress = NULL;
static DecompressResponseFn g_orig_decompress = NULL;
static WwwPostFn g_orig_post = NULL;
static WwwGetBytesFn g_orig_get_bytes = NULL;
static WwwDisposeFn g_orig_dispose = NULL;

static void* hook_compress(void* data, void* method) {
    size_t len = 0;
    uint8_t* body = array_body(data, &len);
    void* compressed = g_orig_compress(data, method);
    if (body && len && compressed) {
        queue_pending(compressed, body, len);
    }
    return compressed;
}

static void* hook_decompress(void* data, void* method) {
    bool found = false;
    ActiveRequest ctx = take_response(data, &found);
    void* decompressed = g_orig_decompress(data, method);
    if (found) {
        size_t len = 0;
        uint8_t* body = array_body(decompressed, &len);
        if (body && len) {
            enqueue_job("/notify/response", ctx.request_id, ctx.url, body, len);
        }
        if (ctx.owner_handle) p_il2cpp_gchandle_free(ctx.owner_handle);
        if (ctx.response_handle) p_il2cpp_gchandle_free(ctx.response_handle);
        free(ctx.url);
        free(ctx.request_id);
    }
    return decompressed;
}

static void hook_post(void* owner, void* url, void* post_data, void* headers, void* method) {
    remove_active(owner);
    size_t body_len = 0;
    uint8_t* body = take_pending(post_data, &body_len);
    char* game_url = read_il2cpp_string(url);
    char request_id[64];
    make_request_id(request_id, sizeof(request_id));
    if (game_url && game_url[0]) {
        store_active(owner, game_url, request_id);
        if (body && body_len) {
            enqueue_job("/notify/request", request_id, game_url, body, body_len);
        }
    }
    free(body);
    free(game_url);
    (void)headers;
    g_orig_post(owner, url, post_data, headers, method);
}

static void* hook_get_bytes(void* owner, void* method) {
    void* response = g_orig_get_bytes(owner, method);
    bind_response(owner, response);
    return response;
}

static void hook_dispose(void* owner, void* method) {
    remove_active(owner);
    g_orig_dispose(owner, method);
}

static bool install_hook(void* target, void* hook, void** original, const char* name) {
    if (!target) {
        log_msg("hook target is null: %s", name);
        return false;
    }
    MH_STATUS st = MH_CreateHook(target, hook, original);
    if (st != MH_OK && st != MH_ERROR_ALREADY_CREATED) {
        log_msg("MH_CreateHook %s failed: %d", name, (int)st);
        return false;
    }
    st = MH_EnableHook(target);
    if (st != MH_OK && st != MH_ERROR_ENABLED) {
        log_msg("MH_EnableHook %s failed: %d", name, (int)st);
        return false;
    }
    log_msg("hooked %s at %p", name, target);
    return true;
}

// ---------------------------------------------------------------------------
// initialization
// ---------------------------------------------------------------------------

static bool wait_and_install(void) {
    log_msg("waiting for GameAssembly.dll");
    for (int attempt = 0; attempt < 600; attempt++) {
        g_game_assembly = GetModuleHandleW(L"GameAssembly.dll");
        if (g_game_assembly) break;
        Sleep(200);
    }
    if (!g_game_assembly) {
        log_msg("GameAssembly.dll not loaded");
        return false;
    }
    log_msg("GameAssembly.dll found at %p", g_game_assembly);
    // Hachimi-Edge waits for CriWare before initializing IL2CPP.  Calling the
    // IL2CPP API too early can leave the GC in a bad state, so use the same
    // trigger and give the runtime a moment to settle.
    log_msg("waiting for cri_ware_unity.dll");
    for (int attempt = 0; attempt < 1500; attempt++) {
        if (GetModuleHandleW(L"cri_ware_unity.dll")) break;
        Sleep(200);
    }
    if (GetModuleHandleW(L"cri_ware_unity.dll")) {
        log_msg("cri_ware_unity.dll found");
    } else {
        log_msg("cri_ware_unity.dll not found; continuing after delay");
    }
    Sleep(2000);
    if (!read_unityplayer()) {
        log_msg("failed to read UnityPlayer.dll");
        return false;
    }
    log_msg("UnityPlayer.dll parsed");
    if (!resolve_il2cpp_api()) {
        log_msg("failed to resolve IL2CPP API");
        return false;
    }
    log_msg("IL2CPP API resolved");

    Il2CppThread thread = NULL;
    for (int attempt = 0; attempt < 600; attempt++) {
        g_domain = p_il2cpp_domain_get();
        if (g_domain) {
            log_msg("IL2CPP domain found at %p", g_domain);
            thread = p_il2cpp_thread_attach(g_domain);
            log_msg("IL2CPP thread attached: %p", thread);
            break;
        }
        Sleep(200);
    }
    if (!g_domain) {
        log_msg("IL2CPP domain not available");
        return false;
    }

    Il2CppImage cute_http = NULL;
    Il2CppImage umamusume = NULL;
    Il2CppClass helper = NULL;
    Il2CppClass www = NULL;
    void* compress = NULL;
    void* decompress = NULL;
    void* post = NULL;
    void* get_bytes = NULL;
    void* dispose = NULL;

    for (int attempt = 0; attempt < 1200; attempt++) {
        if (!cute_http) {
            Il2CppAssembly asm_ = p_il2cpp_domain_assembly_open(g_domain, "Cute.Http.Assembly.dll");
            if (asm_) cute_http = p_il2cpp_assembly_get_image(asm_);
        }
        if (!umamusume) {
            Il2CppAssembly asm_ = p_il2cpp_domain_assembly_open(g_domain, "umamusume.dll");
            if (asm_) umamusume = p_il2cpp_assembly_get_image(asm_);
        }
        if (cute_http && !www) www = p_il2cpp_class_from_name(cute_http, "Cute.Http", "WWWRequest");
        if (umamusume && !helper) helper = p_il2cpp_class_from_name(umamusume, "Gallop", "HttpHelper");

        if (helper) {
            if (!compress) compress = method_addr(p_il2cpp_class_get_method_from_name(helper, "CompressRequest", 1));
            if (!decompress) decompress = method_addr(p_il2cpp_class_get_method_from_name(helper, "DecompressResponse", 1));
        }
        if (www) {
            if (!post) post = method_addr(p_il2cpp_class_get_method_from_name(www, "Post", 3));
            if (!get_bytes) get_bytes = method_addr(p_il2cpp_class_get_method_from_name(www, "get_bytes", 0));
            if (!dispose) dispose = method_addr(p_il2cpp_class_get_method_from_name(www, "Dispose", 0));
        }
        if (compress && decompress && post && get_bytes && dispose) break;
        Sleep(500);
    }

    if (!(compress && decompress && post && get_bytes && dispose)) {
        log_msg("failed to resolve methods (helper=%p www=%p compress=%p decompress=%p post=%p bytes=%p dispose=%p)",
                helper, www, compress, decompress, post, get_bytes, dispose);
        if (thread) p_il2cpp_thread_detach(thread);
        return false;
    }

    MH_STATUS st = MH_Initialize();
    if (st != MH_OK && st != MH_ERROR_ALREADY_INITIALIZED) {
        log_msg("MH_Initialize failed: %d", (int)st);
        if (thread) p_il2cpp_thread_detach(thread);
        return false;
    }

    bool ok = true;
    ok &= install_hook(compress, (void*)hook_compress, (void**)&g_orig_compress, "CompressRequest");
    ok &= install_hook(decompress, (void*)hook_decompress, (void**)&g_orig_decompress, "DecompressResponse");
    ok &= install_hook(post, (void*)hook_post, (void**)&g_orig_post, "WWWRequest.Post");
    ok &= install_hook(get_bytes, (void*)hook_get_bytes, (void**)&g_orig_get_bytes, "WWWRequest.get_bytes");
    ok &= install_hook(dispose, (void*)hook_dispose, (void**)&g_orig_dispose, "WWWRequest.Dispose");

    if (thread) p_il2cpp_thread_detach(thread);
    log_msg(ok ? "capture hooks installed" : "capture hooks partially installed");
    return ok;
}

static DWORD WINAPI capture_thread(LPVOID param) {
    (void)param;
    log_msg("capture thread started");
    // Metadata guard hooks are investigation-only.  Keep them disabled in the
    // production DLL so the game runs with only the HTTP capture hooks.
    // install_metadata_hooks();
    wait_and_install();
    return 0;
}

void capture_start(HINSTANCE instance) {
    (void)instance;
    InitializeCriticalSection(&g_log_lock);
    g_log_lock_ready = true;
    log_msg("capture_start");
    InitializeCriticalSection(&g_job_lock);
    g_job_lock_ready = true;
    InitializeCriticalSection(&g_pending_lock);
    InitializeCriticalSection(&g_active_lock);
    g_track_lock_ready = true;

    g_job_event = CreateEventW(NULL, FALSE, FALSE, NULL);
    if (g_job_event) {
        g_worker_thread = CreateThread(NULL, 0, worker_thread, NULL, 0, NULL);
    }
    log_msg("starting capture thread");
    CreateThread(NULL, 0, capture_thread, NULL, 0, NULL);
}
