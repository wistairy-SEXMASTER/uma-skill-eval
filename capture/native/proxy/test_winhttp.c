#include <windows.h>
#include <winhttp.h>
#include <stdio.h>

int main(void) {
    BOOL ok = WinHttpCheckPlatform();
    FILE* f = fopen("test_result.txt", "w");
    if (f) {
        fprintf(f, "WinHttpCheckPlatform=%d\n", ok ? 1 : 0);
        fclose(f);
    }
    return 0;
}
