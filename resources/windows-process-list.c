#define WIN32_LEAN_AND_MEAN
#include <stdio.h>
#include <tlhelp32.h>
#include <windows.h>

int main(void) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE)
    return 1;
  PROCESSENTRY32W entry = {0};
  entry.dwSize = sizeof(entry);
  if (!Process32FirstW(snapshot, &entry)) {
    CloseHandle(snapshot);
    return 1;
  }
  do {
    char name[MAX_PATH * 4];
    if (WideCharToMultiByte(CP_UTF8, 0, entry.szExeFile, -1, name, sizeof(name),
                            NULL, NULL))
      puts(name);
  } while (Process32NextW(snapshot, &entry));
  DWORD error = GetLastError();
  CloseHandle(snapshot);
  return error == ERROR_NO_MORE_FILES ? 0 : 1;
}
