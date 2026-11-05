// Zero-dependency N-API bridge to libclang (C++ / HIP / CUDA fast in-memory diagnostics).
// Dynamically resolves Both N-API symbols (from the host Bun/Node executable) and libclang
// symbols (from /opt/rocm/llvm/lib/libclang.so, LIBCLANG_PATH, or system libclang) at runtime.
// Runs all clang_parseTranslationUnit2 and clang_reparseTranslationUnit calls on a worker thread
// via napi_async_work so the JS event loop and TUI never block and BUN_AOT_JIT=0 needs no FFI JIT.

#ifndef _WIN32
#define _GNU_SOURCE // dladdr
#endif
#include "../../../../tui/native/napi.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
typedef HMODULE dylib_handle;
typedef CRITICAL_SECTION mutex_type;
static void mutex_init(mutex_type* m) { InitializeCriticalSection(m); }
static void mutex_lock(mutex_type* m) { EnterCriticalSection(m); }
static void mutex_unlock(mutex_type* m) { LeaveCriticalSection(m); }
#else
#include <dirent.h>
#include <limits.h>
#include <pthread.h>
#include <sys/stat.h>
typedef void* dylib_handle;
typedef pthread_mutex_t mutex_type;
static void mutex_init(mutex_type* m) { pthread_mutex_init(m, NULL); }
static void mutex_lock(mutex_type* m) { pthread_mutex_lock(m); }
static void mutex_unlock(mutex_type* m) { pthread_mutex_unlock(m); }
#endif

// --- libclang C ABI definitions ----------------------------------------------------------------------------------------

typedef void* CXIndex;
typedef struct CXTranslationUnitImpl* CXTranslationUnit;
typedef void* CXDiagnostic;
typedef void* CXDiagnosticSet;
typedef void* CXFile;

typedef struct {
    const void* ptr_data;
    unsigned private_flags;
} CXString;

typedef struct {
    const void* ptr_data[2];
    unsigned int_data;
} CXSourceLocation;

struct CXUnsavedFile {
    const char* Filename;
    const char* Contents;
    unsigned long Length;
};

enum CXErrorCode {
    CXError_Success = 0,
    CXError_Failure = 1,
    CXError_Crashed = 2,
    CXError_InvalidArguments = 3,
    CXError_ASTReadError = 4
};

enum CXDiagnosticSeverity {
    CXDiagnostic_Ignored = 0,
    CXDiagnostic_Note = 1,
    CXDiagnostic_Warning = 2,
    CXDiagnostic_Error = 3,
    CXDiagnostic_Fatal = 4
};

enum CXTranslationUnit_Flags {
    CXTranslationUnit_None = 0x0,
    CXTranslationUnit_DetailedPreprocessingRecord = 0x01,
    CXTranslationUnit_Incomplete = 0x02,
    CXTranslationUnit_PrecompiledPreamble = 0x04,
    CXTranslationUnit_CacheCompletionResults = 0x08,
    CXTranslationUnit_ForSerialization = 0x10,
    CXTranslationUnit_CXXChainedPCH = 0x20,
    CXTranslationUnit_SkipFunctionBodies = 0x40,
    CXTranslationUnit_IncludeBriefCommentsInCodeCompletion = 0x80,
    CXTranslationUnit_CreatePreambleOnFirstParse = 0x100,
    CXTranslationUnit_KeepGoing = 0x200,
    CXTranslationUnit_SingleFileParse = 0x400,
    CXTranslationUnit_LimitSkipFunctionBodiesToPreamble = 0x800,
    CXTranslationUnit_IncludeAttributedTypes = 0x1000,
    CXTranslationUnit_VisitImplicitAttributes = 0x2000,
    CXTranslationUnit_IgnoreNonErrorsFromIncludedFiles = 0x4000
};

typedef CXIndex (*clang_createIndex_fn)(int excludeDeclarationsFromPCH, int displayDiagnostics);
typedef void (*clang_disposeIndex_fn)(CXIndex index);
typedef enum CXErrorCode (*clang_parseTranslationUnit2_fn)(
    CXIndex CIdx,
    const char* source_filename,
    const char* const* command_line_args,
    int num_command_line_args,
    struct CXUnsavedFile* unsaved_files,
    unsigned num_unsaved_files,
    unsigned options,
    CXTranslationUnit* out_TU
);
typedef unsigned (*clang_defaultReparseOptions_fn)(CXTranslationUnit TU);
typedef int (*clang_reparseTranslationUnit_fn)(
    CXTranslationUnit TU,
    unsigned num_unsaved_files,
    struct CXUnsavedFile* unsaved_files,
    unsigned options
);
typedef void (*clang_disposeTranslationUnit_fn)(CXTranslationUnit TU);
typedef unsigned (*clang_getNumDiagnostics_fn)(CXTranslationUnit Unit);
typedef CXDiagnostic (*clang_getDiagnostic_fn)(CXTranslationUnit Unit, unsigned Index);
typedef void (*clang_disposeDiagnostic_fn)(CXDiagnostic Diagnostic);
typedef enum CXDiagnosticSeverity (*clang_getDiagnosticSeverity_fn)(CXDiagnostic);
typedef CXSourceLocation (*clang_getDiagnosticLocation_fn)(CXDiagnostic);
typedef CXString (*clang_getDiagnosticSpelling_fn)(CXDiagnostic);
typedef CXString (*clang_getDiagnosticOption_fn)(CXDiagnostic Diag, CXString* Disable);
typedef void (*clang_getSpellingLocation_fn)(
    CXSourceLocation location,
    CXFile* file,
    unsigned* line,
    unsigned* column,
    unsigned* offset
);
typedef CXString (*clang_getFileName_fn)(CXFile SFile);
typedef const char* (*clang_getCString_fn)(CXString string);
typedef void (*clang_disposeString_fn)(CXString string);

static struct {
    bool initialized;
    bool available;
    dylib_handle handle;
    CXIndex index;
    mutex_type lock;
    clang_createIndex_fn createIndex;
    clang_disposeIndex_fn disposeIndex;
    clang_parseTranslationUnit2_fn parseTU2;
    clang_defaultReparseOptions_fn defaultReparseOptions;
    clang_reparseTranslationUnit_fn reparseTU;
    clang_disposeTranslationUnit_fn disposeTU;
    clang_getNumDiagnostics_fn getNumDiagnostics;
    clang_getDiagnostic_fn getDiagnostic;
    clang_disposeDiagnostic_fn disposeDiagnostic;
    clang_getDiagnosticSeverity_fn getDiagnosticSeverity;
    clang_getDiagnosticLocation_fn getDiagnosticLocation;
    clang_getDiagnosticSpelling_fn getDiagnosticSpelling;
    clang_getDiagnosticOption_fn getDiagnosticOption;
    clang_getSpellingLocation_fn getSpellingLocation;
    clang_getFileName_fn getFileName;
    clang_getCString_fn getCString;
    clang_disposeString_fn disposeString;
    // The clang resource folder next to the loaded library (its builtin headers: stddef.h, stdarg.h), or NULL.
    char* resource_dir;
} g_clang;

// --- Translation Unit Cache (FNV-1a Hash Table, the MAX_TUS used last) -------------------------------------------------

#define TU_BUCKET_COUNT 256
// A TU with its preamble holds tens to hundreds of MB (a HIP source with the ROCm headers): keep the ones used last.
#define MAX_TUS 8

typedef struct tu_entry {
    uint64_t hash;
    char* filename;
    CXTranslationUnit tu;
    // The arguments the TU was parsed with: a reparse keeps them, and a parse after a failed reparse needs them again.
    char** args;
    int num_args;
    uint64_t args_hash;
    uint64_t last_used;
    struct tu_entry* next;
} tu_entry;

static tu_entry* g_tu_buckets[TU_BUCKET_COUNT];
static unsigned g_tu_count = 0;
static uint64_t g_tu_clock = 0;

static uint64_t fnv1a_hash(const char* str) {
    uint64_t h = 14695981039346656037ULL;
    for (const unsigned char* p = (const unsigned char*)str; *p; p++) {
        h ^= (uint64_t)(*p);
        h *= 1099511628211ULL;
    }
    return h;
}

static dylib_handle open_dylib(const char* path) {
#ifdef _WIN32
    return LoadLibraryA(path);
#else
    return dlopen(path, RTLD_LAZY | RTLD_LOCAL);
#endif
}

static void* dylib_sym(dylib_handle h, const char* name) {
#ifdef _WIN32
    return (void*)GetProcAddress(h, name);
#else
    return dlsym(h, name);
#endif
}

// libclang looks for its builtin headers relative to the running executable, here Bun or Node, so it misses them
// (every C file then reports "'stddef.h' file not found" and "unknown type name 'size_t'"). They sit next to the
// library: <libdir>/clang/<version>/include.
static char* find_resource_dir(void* symbol) {
#ifdef _WIN32
    (void)symbol;
    return NULL;
#else
    Dl_info info;
    if (!dladdr(symbol, &info) || !info.dli_fname) return NULL;
    char lib[PATH_MAX];
    if (!realpath(info.dli_fname, lib)) return NULL;
    char* slash = strrchr(lib, '/');
    if (!slash) return NULL;
    *slash = '\0';
    char clang_dir[PATH_MAX];
    if (snprintf(clang_dir, sizeof clang_dir, "%s/clang", lib) >= (int)sizeof clang_dir) return NULL;
    DIR* dir = opendir(clang_dir);
    if (!dir) return NULL;
    char* found = NULL;
    struct dirent* entry;
    while (!found && (entry = readdir(dir)) != NULL) {
        if (entry->d_name[0] == '.') continue;
        char header[PATH_MAX];
        if (snprintf(header, sizeof header, "%s/%s/include/stddef.h", clang_dir, entry->d_name) >= (int)sizeof header)
            continue;
        struct stat st;
        if (stat(header, &st) == 0) {
            *strrchr(header, '/') = '\0';
            *strrchr(header, '/') = '\0';
            found = strdup(header);
        }
    }
    closedir(dir);
    return found;
#endif
}

static bool try_load_libclang(const char* custom_path) {
    if (g_clang.initialized) return g_clang.available;
    mutex_init(&g_clang.lock);
    g_clang.initialized = true;

    const char* candidates[16];
    int count = 0;
    if (custom_path && custom_path[0]) candidates[count++] = custom_path;
    const char* env_path = getenv("LIBCLANG_PATH");
    if (env_path && env_path[0]) candidates[count++] = env_path;

#ifdef _WIN32
    candidates[count++] = "libclang.dll";
    candidates[count++] = "C:\\Program Files\\LLVM\\bin\\libclang.dll";
    candidates[count++] = "C:\\Program Files\\AMD\\ROCm\\llvm\\bin\\libclang.dll";
#elif defined(__APPLE__)
    candidates[count++] = "/opt/homebrew/opt/llvm/lib/libclang.dylib";
    candidates[count++] = "/Library/Developer/CommandLineTools/usr/lib/libclang.dylib";
    candidates[count++] = "libclang.dylib";
#else
    candidates[count++] = "/opt/rocm/llvm/lib/libclang.so";
    candidates[count++] = "/opt/rocm/lib/llvm/lib/libclang.so";
    candidates[count++] = "libclang.so";
    candidates[count++] = "libclang.so.19";
    candidates[count++] = "libclang.so.18";
    candidates[count++] = "libclang.so.17";
    candidates[count++] = "libclang.so.16";
    candidates[count++] = "/usr/lib/llvm-19/lib/libclang.so.1";
    candidates[count++] = "/usr/lib/llvm-18/lib/libclang.so.1";
    candidates[count++] = "/usr/lib/llvm-17/lib/libclang.so.1";
    candidates[count++] = "/usr/lib/x86_64-linux-gnu/libclang-18.so.1";
    candidates[count++] = "/usr/lib/x86_64-linux-gnu/libclang-17.so.1";
#endif

    for (int i = 0; i < count; i++) {
        dylib_handle h = open_dylib(candidates[i]);
        if (!h) continue;

        g_clang.createIndex = (clang_createIndex_fn)dylib_sym(h, "clang_createIndex");
        g_clang.disposeIndex = (clang_disposeIndex_fn)dylib_sym(h, "clang_disposeIndex");
        g_clang.parseTU2 = (clang_parseTranslationUnit2_fn)dylib_sym(h, "clang_parseTranslationUnit2");
        g_clang.defaultReparseOptions = (clang_defaultReparseOptions_fn)dylib_sym(h, "clang_defaultReparseOptions");
        g_clang.reparseTU = (clang_reparseTranslationUnit_fn)dylib_sym(h, "clang_reparseTranslationUnit");
        g_clang.disposeTU = (clang_disposeTranslationUnit_fn)dylib_sym(h, "clang_disposeTranslationUnit");
        g_clang.getNumDiagnostics = (clang_getNumDiagnostics_fn)dylib_sym(h, "clang_getNumDiagnostics");
        g_clang.getDiagnostic = (clang_getDiagnostic_fn)dylib_sym(h, "clang_getDiagnostic");
        g_clang.disposeDiagnostic = (clang_disposeDiagnostic_fn)dylib_sym(h, "clang_disposeDiagnostic");
        g_clang.getDiagnosticSeverity = (clang_getDiagnosticSeverity_fn)dylib_sym(h, "clang_getDiagnosticSeverity");
        g_clang.getDiagnosticLocation = (clang_getDiagnosticLocation_fn)dylib_sym(h, "clang_getDiagnosticLocation");
        g_clang.getDiagnosticSpelling = (clang_getDiagnosticSpelling_fn)dylib_sym(h, "clang_getDiagnosticSpelling");
        g_clang.getDiagnosticOption = (clang_getDiagnosticOption_fn)dylib_sym(h, "clang_getDiagnosticOption");
        g_clang.getSpellingLocation = (clang_getSpellingLocation_fn)dylib_sym(h, "clang_getSpellingLocation");
        g_clang.getFileName = (clang_getFileName_fn)dylib_sym(h, "clang_getFileName");
        g_clang.getCString = (clang_getCString_fn)dylib_sym(h, "clang_getCString");
        g_clang.disposeString = (clang_disposeString_fn)dylib_sym(h, "clang_disposeString");

        if (g_clang.createIndex && g_clang.parseTU2 && g_clang.reparseTU &&
            g_clang.getNumDiagnostics && g_clang.getDiagnostic && g_clang.getCString) {
            g_clang.handle = h;
            g_clang.resource_dir = find_resource_dir((void*)g_clang.createIndex);
            g_clang.index = g_clang.createIndex(0, 0);
            g_clang.available = (g_clang.index != NULL);
            return g_clang.available;
        }
    }
    return false;
}

static tu_entry* find_tu_entry(const char* filename) {
    uint64_t h = fnv1a_hash(filename);
    unsigned idx = (unsigned)(h & (TU_BUCKET_COUNT - 1));
    for (tu_entry* cur = g_tu_buckets[idx]; cur != NULL; cur = cur->next) {
        if (cur->hash == h && strcmp(cur->filename, filename) == 0) return cur;
    }
    return NULL;
}

static uint64_t args_hash(char** args, int num_args) {
    uint64_t h = 14695981039346656037ULL;
    for (int i = 0; i < num_args; i++) {
        for (const unsigned char* p = (const unsigned char*)args[i]; *p; p++) {
            h ^= (uint64_t)(*p);
            h *= 1099511628211ULL;
        }
        h ^= 0xff; // (An argument's end: "-a" "b" and "-ab" differ.)
        h *= 1099511628211ULL;
    }
    return h;
}

static void free_args(char** args, int num_args) {
    if (!args) return;
    for (int i = 0; i < num_args; i++) free(args[i]);
    free(args);
}

static char** copy_args(char** args, int num_args) {
    char** copy = (char**)calloc(num_args > 0 ? (size_t)num_args : 1, sizeof(char*));
    if (!copy) return NULL;
    for (int i = 0; i < num_args; i++) {
        copy[i] = strdup(args[i]);
        if (!copy[i]) {
            free_args(copy, i);
            return NULL;
        }
    }
    return copy;
}

static void remove_tu_entry(tu_entry* entry) {
    unsigned idx = (unsigned)(entry->hash & (TU_BUCKET_COUNT - 1));
    for (tu_entry** link = &g_tu_buckets[idx]; *link != NULL; link = &(*link)->next) {
        if (*link == entry) {
            *link = entry->next;
            break;
        }
    }
    if (entry->tu && g_clang.disposeTU) g_clang.disposeTU(entry->tu);
    free_args(entry->args, entry->num_args);
    free(entry->filename);
    free(entry);
    g_tu_count--;
}

/** Disposes the TUs used longest ago while more than MAX_TUS are kept (`keep` stays). */
static void evict_tu_entries(tu_entry* keep) {
    while (g_tu_count > MAX_TUS) {
        tu_entry* oldest = NULL;
        for (unsigned i = 0; i < TU_BUCKET_COUNT; i++) {
            for (tu_entry* cur = g_tu_buckets[i]; cur != NULL; cur = cur->next) {
                if (cur != keep && (!oldest || cur->last_used < oldest->last_used)) oldest = cur;
            }
        }
        if (!oldest) return;
        remove_tu_entry(oldest);
    }
}

/** Stores `tu`, parsed with `args`, for `filename`. Returns NULL (and leaves `tu` to the caller) when out of memory. */
static tu_entry* upsert_tu_entry(const char* filename, CXTranslationUnit tu, char** args, int num_args) {
    // (`args` may be the entry's own, freed below: copied and hashed first.)
    char** args_copy = copy_args(args, num_args);
    if (!args_copy) return NULL;
    uint64_t new_args_hash = args_hash(args, num_args);
    tu_entry* entry = find_tu_entry(filename);
    if (entry) {
        if (entry->tu && entry->tu != tu && g_clang.disposeTU) {
            g_clang.disposeTU(entry->tu);
        }
        free_args(entry->args, entry->num_args);
    } else {
        entry = (tu_entry*)calloc(1, sizeof(tu_entry));
        if (!entry || !(entry->filename = strdup(filename))) {
            free(entry);
            free_args(args_copy, num_args);
            return NULL;
        }
        entry->hash = fnv1a_hash(filename);
        unsigned idx = (unsigned)(entry->hash & (TU_BUCKET_COUNT - 1));
        entry->next = g_tu_buckets[idx];
        g_tu_buckets[idx] = entry;
        g_tu_count++;
    }
    entry->tu = tu;
    entry->args = args_copy;
    entry->num_args = num_args;
    entry->args_hash = new_args_hash;
    entry->last_used = ++g_tu_clock;
    evict_tu_entries(entry);
    return entry;
}

// --- Async Worker Job Structure ----------------------------------------------------------------------------------------

typedef struct {
    char* filename;
    char* content;
    size_t content_len;
} unsaved_item;

typedef struct {
    napi_async_work work;
    napi_deferred deferred;
    char* filename;
    char** args;
    int num_args;
    unsaved_item* unsaved;
    unsigned num_unsaved;
    bool warmup_only;
    char* result_json;
    char* error;
} clang_job;

static void free_clang_job(clang_job* job) {
    if (!job) return;
    free(job->filename);
    if (job->args) {
        for (int i = 0; i < job->num_args; i++) free(job->args[i]);
        free(job->args);
    }
    if (job->unsaved) {
        for (unsigned i = 0; i < job->num_unsaved; i++) {
            free(job->unsaved[i].filename);
            free(job->unsaved[i].content);
        }
        free(job->unsaved);
    }
    free(job->result_json);
    free(job);
}

typedef struct {
    char* data;
    size_t len;
    size_t cap;
} str_buf;

static void sb_append(str_buf* sb, const char* s, size_t n) {
    if (sb->len + n + 1 > sb->cap) {
        size_t next_cap = sb->cap ? sb->cap * 2 : 1024;
        while (next_cap < sb->len + n + 1) next_cap *= 2;
        char* next_data = (char*)realloc(sb->data, next_cap);
        if (!next_data) return;
        sb->data = next_data;
        sb->cap = next_cap;
    }
    memcpy(sb->data + sb->len, s, n);
    sb->len += n;
    sb->data[sb->len] = '\0';
}

static void sb_append_cstr(str_buf* sb, const char* s) {
    if (s) sb_append(sb, s, strlen(s));
}

static void sb_append_json_escaped(str_buf* sb, const char* s) {
    sb_append(sb, "\"", 1);
    if (s) {
        for (const unsigned char* p = (const unsigned char*)s; *p; p++) {
            unsigned char c = *p;
            if (c == '"') sb_append(sb, "\\\"", 2);
            else if (c == '\\') sb_append(sb, "\\\\", 2);
            else if (c == '\n') sb_append(sb, "\\n", 2);
            else if (c == '\r') sb_append(sb, "\\r", 2);
            else if (c == '\t') sb_append(sb, "\\t", 2);
            else if (c < 0x20) {
                char hex[8];
                snprintf(hex, sizeof(hex), "\\u%04x", c);
                sb_append_cstr(sb, hex);
            } else {
                sb_append(sb, (const char*)p, 1);
            }
        }
    }
    sb_append(sb, "\"", 1);
}

static char* serialize_diagnostics(CXTranslationUnit tu) {
    str_buf sb = {0};
    sb_append_cstr(&sb, "[");
    unsigned count = g_clang.getNumDiagnostics(tu);
    bool first = true;

    for (unsigned i = 0; i < count; i++) {
        CXDiagnostic diag = g_clang.getDiagnostic(tu, i);
        if (!diag) continue;

        enum CXDiagnosticSeverity sev = g_clang.getDiagnosticSeverity(diag);
        // Only keep Warnings (2), Errors (3), Fatal (4)
        if (sev >= CXDiagnostic_Warning) {
            CXSourceLocation loc = g_clang.getDiagnosticLocation(diag);
            CXFile file = NULL;
            unsigned line = 0, column = 0, offset = 0;
            g_clang.getSpellingLocation(loc, &file, &line, &column, &offset);

            CXString file_str = file ? g_clang.getFileName(file) : (CXString){0};
            const char* file_cstr = file ? g_clang.getCString(file_str) : "";

            CXString spell_str = g_clang.getDiagnosticSpelling(diag);
            const char* spell_cstr = g_clang.getCString(spell_str);

            CXString opt_str = {0};
            const char* opt_cstr = "";
            if (g_clang.getDiagnosticOption) {
                opt_str = g_clang.getDiagnosticOption(diag, NULL);
                opt_cstr = g_clang.getCString(opt_str);
            }

            if (!first) sb_append_cstr(&sb, ",");
            first = false;

            char num_buf[128];
            snprintf(
                num_buf,
                sizeof(num_buf),
                "{\"line\":%u,\"column\":%u,\"severity\":%u,\"file\":",
                line,
                column,
                (unsigned)sev
            );
            sb_append_cstr(&sb, num_buf);
            sb_append_json_escaped(&sb, file_cstr ? file_cstr : "");
            sb_append_cstr(&sb, ",\"message\":");
            sb_append_json_escaped(&sb, spell_cstr ? spell_cstr : "");
            sb_append_cstr(&sb, ",\"code\":");
            sb_append_json_escaped(&sb, opt_cstr ? opt_cstr : "");
            sb_append_cstr(&sb, "}");

            if (g_clang.getDiagnosticOption) g_clang.disposeString(opt_str);
            g_clang.disposeString(spell_str);
            if (file) g_clang.disposeString(file_str);
        }
        g_clang.disposeDiagnostic(diag);
    }

    sb_append_cstr(&sb, "]");
    return sb.data ? sb.data : strdup("[]");
}

static void PI_NAPI_CALL execute_clang_work(napi_env env, void* data) {
    (void)env;
    clang_job* job = (clang_job*)data;
    if (!g_clang.available) {
        job->error = "libclang is not available";
        return;
    }

    struct CXUnsavedFile* unsaved_arr = NULL;
    if (job->num_unsaved > 0) {
        unsaved_arr = (struct CXUnsavedFile*)calloc(job->num_unsaved, sizeof(struct CXUnsavedFile));
        if (!unsaved_arr) {
            job->error = "Out of memory allocating CXUnsavedFile";
            return;
        }
        for (unsigned i = 0; i < job->num_unsaved; i++) {
            unsaved_arr[i].Filename = job->unsaved[i].filename;
            unsaved_arr[i].Contents = job->unsaved[i].content;
            unsaved_arr[i].Length = (unsigned long)job->unsaved[i].content_len;
        }
    }

    mutex_lock(&g_clang.lock);
    tu_entry* entry = find_tu_entry(job->filename);
    CXTranslationUnit tu = entry ? entry->tu : NULL;
    // A reparse keeps the arguments of the first parse: new ones (a changed compile_commands.json) need a new parse.
    if (tu != NULL && job->num_args > 0 && entry->args_hash != args_hash(job->args, job->num_args)) {
        g_clang.disposeTU(tu);
        entry->tu = NULL;
        tu = NULL;
    }
    // Without arguments given, a parse (a reparse that failed) uses those the TU was parsed with.
    char** parse_args = job->args;
    int parse_num_args = job->num_args;
    if (entry && job->num_args == 0) {
        parse_args = entry->args;
        parse_num_args = entry->num_args;
    }

    // The resource folder unless the arguments name one; kept out of the stored arguments, so their hash stays.
    char** full_args = NULL;
    if (g_clang.resource_dir) {
        bool named = false;
        for (int i = 0; i < parse_num_args; i++) {
            if (strncmp(parse_args[i], "-resource-dir", 13) == 0) named = true;
        }
        if (!named) full_args = (char**)malloc((size_t)(parse_num_args + 2) * sizeof(char*));
        if (full_args) {
            for (int i = 0; i < parse_num_args; i++) full_args[i] = parse_args[i];
            full_args[parse_num_args] = "-resource-dir";
            full_args[parse_num_args + 1] = g_clang.resource_dir;
        }
    }

    unsigned parse_options = CXTranslationUnit_PrecompiledPreamble |
                             CXTranslationUnit_CreatePreambleOnFirstParse |
                             CXTranslationUnit_CacheCompletionResults |
                             CXTranslationUnit_KeepGoing |
                             CXTranslationUnit_IgnoreNonErrorsFromIncludedFiles;

    if (tu != NULL) {
        // Fast in-memory reparse using the precompiled preamble in RAM!
        unsigned reparse_opts = g_clang.defaultReparseOptions ? g_clang.defaultReparseOptions(tu) : 0;
        int rc = g_clang.reparseTU(tu, job->num_unsaved, unsaved_arr, reparse_opts);
        if (rc != 0) {
            // If reparse failed, dispose and re-create TU from scratch
            g_clang.disposeTU(tu);
            entry->tu = NULL;
            tu = NULL;
        } else {
            entry->last_used = ++g_tu_clock;
        }
    }

    if (tu == NULL) {
        enum CXErrorCode err = g_clang.parseTU2(
            g_clang.index,
            job->filename,
            (const char* const*)(full_args ? full_args : parse_args),
            full_args ? parse_num_args + 2 : parse_num_args,
            unsaved_arr,
            job->num_unsaved,
            parse_options,
            &tu
        );
        if (err == CXError_Success && tu != NULL) {
            if (!upsert_tu_entry(job->filename, tu, parse_args, parse_num_args)) {
                // Not kept: the diagnostics are still read below, then the TU goes.
                job->result_json = serialize_diagnostics(tu);
                g_clang.disposeTU(tu);
                tu = NULL;
            }
        } else {
            job->error = "clang_parseTranslationUnit2 failed";
        }
    }

    if (tu != NULL && !job->error) {
        job->result_json = serialize_diagnostics(tu);
    }
    mutex_unlock(&g_clang.lock);
    free(full_args);
    free(unsaved_arr);
}

static void PI_NAPI_CALL complete_clang_work(napi_env env, int status, void* data) {
    clang_job* job = (clang_job*)data;
    napi_create_string_utf8_fn create_string =
        (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_create_error_fn create_error =
        (napi_create_error_fn)node_symbol("napi_create_error");
    napi_settle_deferred_fn resolve_deferred =
        (napi_settle_deferred_fn)node_symbol("napi_resolve_deferred");
    napi_settle_deferred_fn reject_deferred =
        (napi_settle_deferred_fn)node_symbol("napi_reject_deferred");
    napi_async_work_fn delete_async_work =
        (napi_async_work_fn)node_symbol("napi_delete_async_work");

    if (status != 0 || job->error) {
        if (create_string && create_error && reject_deferred) {
            const char* message = job->error ? job->error : "libclang async work failed";
            napi_value msg_val = 0, err_val = 0;
            if (create_string(env, message, NAPI_AUTO_LENGTH, &msg_val) == 0 &&
                create_error(env, 0, msg_val, &err_val) == 0) {
                reject_deferred(env, job->deferred, err_val);
            }
        }
    } else if (create_string && resolve_deferred) {
        const char* json = job->result_json ? job->result_json : "[]";
        napi_value str_val = 0;
        if (create_string(env, json, strlen(json), &str_val) == 0) {
            resolve_deferred(env, job->deferred, str_val);
        }
    }

    if (delete_async_work && job->work) delete_async_work(env, job->work);
    free_clang_job(job);
}

static char* dup_napi_utf8(napi_env env, napi_value val, size_t* out_len) {
    napi_get_value_string_utf8_fn get_utf8 =
        (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    if (!get_utf8) return NULL;
    size_t len = 0;
    if (get_utf8(env, val, NULL, 0, &len) != 0) return NULL;
    char* buf = (char*)malloc(len + 1);
    if (!buf) return NULL;
    if (get_utf8(env, val, buf, len + 1, &len) != 0) {
        free(buf);
        return NULL;
    }
    if (out_len) *out_len = len;
    return buf;
}

typedef int (PI_NAPI_CALL *napi_get_array_length_fn)(napi_env, napi_value, uint32_t*);
typedef int (PI_NAPI_CALL *napi_get_element_fn)(napi_env, napi_value, uint32_t, napi_value*);
typedef int (PI_NAPI_CALL *napi_get_named_property_fn)(napi_env, napi_value, const char*, napi_value*);

// JS signature: initLibclang(customPath?: string): boolean
static napi_value js_init_libclang(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_boolean_fn get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    size_t argc = 1;
    napi_value argv[1] = {0};
    char* custom_path = NULL;
    if (get_cb_info && get_cb_info(env, info, &argc, argv, NULL, NULL) == 0 && argc >= 1) {
        custom_path = dup_napi_utf8(env, argv[0], NULL);
    }
    bool ok = try_load_libclang(custom_path);
    free(custom_path);
    napi_value res = 0;
    if (get_boolean) get_boolean(env, ok, &res);
    return res;
}

// JS signature: checkFileAsync(filename: string, args: string[], unsavedFiles: Array<{filename: string, content: string}>): Promise<string>
static napi_value js_check_file_async(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_array_length_fn get_array_length = (napi_get_array_length_fn)node_symbol("napi_get_array_length");
    napi_get_element_fn get_element = (napi_get_element_fn)node_symbol("napi_get_element");
    napi_get_named_property_fn get_named_prop = (napi_get_named_property_fn)node_symbol("napi_get_named_property");
    napi_create_promise_fn create_promise = (napi_create_promise_fn)node_symbol("napi_create_promise");
    napi_create_string_utf8_fn create_string = (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_create_async_work_fn create_async_work = (napi_create_async_work_fn)node_symbol("napi_create_async_work");
    napi_async_work_fn queue_async_work = (napi_async_work_fn)node_symbol("napi_queue_async_work");

    if (!get_cb_info || !get_array_length || !get_element || !get_named_prop ||
        !create_promise || !create_string || !create_async_work || !queue_async_work) {
        return fail(env, "N-API symbols missing");
    }

    if (!g_clang.initialized) try_load_libclang(NULL);
    if (!g_clang.available) return fail(env, "libclang is not loaded");

    size_t argc = 3;
    napi_value argv[3] = {0};
    if (get_cb_info(env, info, &argc, argv, NULL, NULL) != 0 || argc < 3) {
        return fail(env, "Expected (filename, args, unsavedFiles)");
    }

    clang_job* job = (clang_job*)calloc(1, sizeof(clang_job));
    if (!job) return fail(env, "Out of memory");

    job->filename = dup_napi_utf8(env, argv[0], NULL);
    if (!job->filename) {
        free_clang_job(job);
        return fail(env, "Invalid filename");
    }

    uint32_t args_len = 0;
    if (get_array_length(env, argv[1], &args_len) == 0 && args_len > 0) {
        job->args = (char**)calloc(args_len, sizeof(char*));
        job->num_args = (int)args_len;
        for (uint32_t i = 0; i < args_len; i++) {
            napi_value elem = 0;
            if (get_element(env, argv[1], i, &elem) == 0) {
                job->args[i] = dup_napi_utf8(env, elem, NULL);
            }
            if (!job->args[i]) job->args[i] = strdup("");
        }
    }

    uint32_t unsaved_len = 0;
    if (get_array_length(env, argv[2], &unsaved_len) == 0 && unsaved_len > 0) {
        job->unsaved = (unsaved_item*)calloc(unsaved_len, sizeof(unsaved_item));
        job->num_unsaved = unsaved_len;
        for (uint32_t i = 0; i < unsaved_len; i++) {
            napi_value item = 0, fn_val = 0, content_val = 0;
            if (get_element(env, argv[2], i, &item) == 0) {
                get_named_prop(env, item, "filename", &fn_val);
                get_named_prop(env, item, "content", &content_val);
                job->unsaved[i].filename = dup_napi_utf8(env, fn_val, NULL);
                job->unsaved[i].content = dup_napi_utf8(env, content_val, &job->unsaved[i].content_len);
            }
            if (!job->unsaved[i].filename) job->unsaved[i].filename = strdup("");
            if (!job->unsaved[i].content) {
                job->unsaved[i].content = strdup("");
                job->unsaved[i].content_len = 0;
            }
        }
    }

    napi_value promise = 0, resource_name = 0;
    if (create_promise(env, &job->deferred, &promise) != 0 ||
        create_string(env, "pi-libclang-work", NAPI_AUTO_LENGTH, &resource_name) != 0 ||
        create_async_work(env, 0, resource_name, execute_clang_work, complete_clang_work, job, &job->work) != 0 ||
        queue_async_work(env, job->work) != 0) {
        free_clang_job(job);
        return fail(env, "Failed to queue libclang async work");
    }

    return promise;
}

PI_NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "initLibclang", js_init_libclang);
    set_function_export(env, exports, "checkFileAsync", js_check_file_async);
    return exports;
}
