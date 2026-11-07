// Standalone test for the UnityPlayer symbol table parser.
// Build with:
//   zig cc -target x86_64-windows-gnu -I minhook/include -I minhook/src \
//     -o test_symbols.exe test_symbols.c ../minhook/src/buffer.c ...

#define CAPTURE_TEST 1
#include "capture.c"

int main(void) {
    InitializeCriticalSection(&g_log_lock);
    g_log_lock_ready = true;
    if (!read_unityplayer()) {
        printf("read_unityplayer failed\n");
        return 1;
    }
    printf("unityplayer size=%zu\n", g_unityplayer_size);
    const char* names[] = {
        "il2cpp_domain_get",
        "il2cpp_domain_assembly_open",
        "il2cpp_assembly_get_image",
        "il2cpp_class_from_name",
        "il2cpp_class_get_method_from_name",
        "il2cpp_object_get_class",
        "il2cpp_class_is_valuetype",
        "il2cpp_object_unbox",
        "il2cpp_runtime_invoke",
        "il2cpp_string_length",
        "il2cpp_string_chars",
        "il2cpp_gchandle_new",
        "il2cpp_gchandle_get_target",
        "il2cpp_gchandle_free",
        "il2cpp_thread_attach",
        "il2cpp_thread_detach",
    };
    for (size_t i = 0; i < sizeof(names) / sizeof(names[0]); i++) {
        char* n = obfuscated_name_for(names[i]);
        printf("%s -> %s\n", names[i], n ? n : "(null)");
        free(n);
    }
    return 0;
}
