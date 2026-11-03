/*
 * Zero-dependency N-API C addon for fff-style fast file search and SIMD grep.
 *
 * Designed specifically for Pi-Bolt (works under BUN_AOT_JIT=0):
 *  - SIMD-accelerated / 64-bit word-at-a-time literal & case-insensitive byte search
 *  - Multi-pattern OR prefilter & matching (Aho-Corasick / first-byte bitmask)
 *  - Smith-Waterman + Bitmask Prefilter Fuzzy Path Scorer with Frecency & Git boosts
 */

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#if defined(__AVX2__)
#include <immintrin.h>
#elif defined(__ARM_NEON) || defined(__ARM_NEON__)
#include <arm_neon.h>
#endif

/* ============================================================================
 * Minimal N-API Type & Function Declarations (ABI-stable across Node & Bun)
 * ============================================================================ */

typedef struct napi_env__* napi_env;
typedef struct napi_value__* napi_value;
typedef struct napi_callback_info__* napi_callback_info;

typedef enum {
	napi_ok = 0
} napi_status;

typedef napi_value (*napi_callback)(napi_env env, napi_callback_info info);

typedef struct {
	const char* utf8name;
	napi_value name;
	napi_callback method;
	napi_callback getter;
	napi_callback setter;
	napi_value value;
	unsigned int attributes;
	void* data;
} napi_property_descriptor;

#if defined(_WIN32)
#define NAPI_EXPORT __declspec(dllexport)
#else
#define NAPI_EXPORT __attribute__((visibility("default")))
#endif

extern napi_status napi_define_properties(napi_env env, napi_value object, size_t property_count, const napi_property_descriptor* properties);
extern napi_status napi_get_cb_info(napi_env env, napi_callback_info cbinfo, size_t* argc, napi_value* argv, napi_value* this_arg, void** data);
extern napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char* buf, size_t bufsize, size_t* result);
extern napi_status napi_get_value_int32(napi_env env, napi_value value, int32_t* result);
extern napi_status napi_get_value_bool(napi_env env, napi_value value, int* result);
extern napi_status napi_get_buffer_info(napi_env env, napi_value value, void** data, size_t* length);
extern napi_status napi_get_array_length(napi_env env, napi_value value, uint32_t* result);
extern napi_status napi_get_element(napi_env env, napi_value object, uint32_t index, napi_value* result);
extern napi_status napi_create_array(napi_env env, napi_value* result);
extern napi_status napi_create_array_with_length(napi_env env, size_t length, napi_value* result);
extern napi_status napi_create_object(napi_env env, napi_value* result);
extern napi_status napi_create_string_utf8(napi_env env, const char* str, size_t length, napi_value* result);
extern napi_status napi_create_int32(napi_env env, int32_t value, napi_value* result);
extern napi_status napi_set_named_property(napi_env env, napi_value object, const char* utf8name, napi_value value);
extern napi_status napi_set_element(napi_env env, napi_value object, uint32_t index, napi_value value);

/* ============================================================================
 * 1. SIMD & SWAR Fast Byte Scanning Primitives
 * ============================================================================ */

static inline uint8_t ascii_tolower(uint8_t c) {
	return (c >= 'A' && c <= 'Z') ? (uint8_t)(c + 32) : c;
}

static inline int has_nul_byte_fast(const uint8_t* buf, size_t len) {
	size_t i = 0;
#if defined(__AVX2__)
	const __m256i zero = _mm256_setzero_si256();
	for (; i + 32 <= len; i += 32) {
		__m256i chunk = _mm256_loadu_si256((const __m256i*)(buf + i));
		__m256i cmp = _mm256_cmpeq_epi8(chunk, zero);
		if (_mm256_movemask_epi8(cmp) != 0) return 1;
	}
#elif defined(__ARM_NEON) || defined(__ARM_NEON__)
	const uint8x16_t zero = vdupq_n_u8(0);
	for (; i + 16 <= len; i += 16) {
		uint8x16_t chunk = vld1q_u8(buf + i);
		uint8x16_t cmp = vceqq_u8(chunk, zero);
		if (vmaxvq_u8(cmp) != 0) return 1;
	}
#endif
	return memchr(buf + i, 0, len - i) != NULL;
}

static inline uint32_t count_newlines_fast(const uint8_t* buf, size_t from, size_t to) {
	if (from >= to) return 0;
	const uint8_t* p = buf + from;
	size_t len = to - from;
	uint32_t count = 0;
	size_t i = 0;
#if defined(__AVX2__)
	const __m256i nl = _mm256_set1_epi8('\n');
	for (; i + 32 <= len; i += 32) {
		__m256i chunk = _mm256_loadu_si256((const __m256i*)(p + i));
		uint32_t mask = (uint32_t)_mm256_movemask_epi8(_mm256_cmpeq_epi8(chunk, nl));
#if defined(__GNUC__) || defined(__clang__)
		count += (uint32_t)__builtin_popcount(mask);
#else
		while (mask) {
			mask &= mask - 1;
			count++;
		}
#endif
	}
#endif
	for (; i < len; i++) {
		if (p[i] == '\n') count++;
	}
	return count;
}

/* SIMD-accelerated first-/last-byte memmem (exact case) */
static ptrdiff_t simd_find_exact(const uint8_t* hay, size_t hay_len, const uint8_t* needle, size_t needle_len, size_t from) {
	if (needle_len == 0) return (from <= hay_len) ? (ptrdiff_t)from : -1;
	if (from + needle_len > hay_len) return -1;

	const uint8_t first = needle[0];
	if (needle_len == 1) {
		const void* p = memchr(hay + from, first, hay_len - from);
		return p ? (ptrdiff_t)((const uint8_t*)p - hay) : -1;
	}

	const uint8_t last = needle[needle_len - 1];
	const size_t limit = hay_len - needle_len;
	size_t i = from;

#if defined(__AVX2__)
	const __m256i v_first = _mm256_set1_epi8((char)first);
	const __m256i v_last = _mm256_set1_epi8((char)last);
	for (; i + 32 <= limit + 1; i += 32) {
		__m256i block_first = _mm256_loadu_si256((const __m256i*)(hay + i));
		__m256i block_last = _mm256_loadu_si256((const __m256i*)(hay + i + needle_len - 1));
		uint32_t mask = (uint32_t)_mm256_movemask_epi8(_mm256_and_si256(
			_mm256_cmpeq_epi8(block_first, v_first),
			_mm256_cmpeq_epi8(block_last, v_last)
		));
		while (mask != 0) {
#if defined(__GNUC__) || defined(__clang__)
			uint32_t bit = (uint32_t)__builtin_ctz(mask);
#else
			uint32_t bit = 0;
			while (((mask >> bit) & 1u) == 0) bit++;
#endif
			size_t pos = i + bit;
			if (needle_len <= 2 || memcmp(hay + pos + 1, needle + 1, needle_len - 2) == 0) {
				return (ptrdiff_t)pos;
			}
			mask &= mask - 1;
		}
	}
#endif

	while (i <= limit) {
		const uint8_t* p = (const uint8_t*)memchr(hay + i, first, limit - i + 1);
		if (!p) return -1;
		size_t pos = (size_t)(p - hay);
		if (hay[pos + needle_len - 1] == last &&
			(needle_len <= 2 || memcmp(hay + pos + 1, needle + 1, needle_len - 2) == 0)) {
			return (ptrdiff_t)pos;
		}
		i = pos + 1;
	}
	return -1;
}

/* SIMD-accelerated ASCII case-insensitive substring search (needle is already lowercase) */
static ptrdiff_t simd_find_icase(const uint8_t* hay, size_t hay_len, const uint8_t* needle_lower, size_t needle_len, size_t from) {
	if (needle_len == 0) return (from <= hay_len) ? (ptrdiff_t)from : -1;
	if (from + needle_len > hay_len) return -1;

	const uint8_t first_lo = needle_lower[0];
	const uint8_t first_hi = (first_lo >= 'a' && first_lo <= 'z') ? (uint8_t)(first_lo - 32) : first_lo;
	const uint8_t last_lo = needle_lower[needle_len - 1];
	const uint8_t last_hi = (last_lo >= 'a' && last_lo <= 'z') ? (uint8_t)(last_lo - 32) : last_lo;
	const size_t limit = hay_len - needle_len;
	size_t i = from;

#if defined(__AVX2__)
	const __m256i vf_lo = _mm256_set1_epi8((char)first_lo);
	const __m256i vf_hi = _mm256_set1_epi8((char)first_hi);
	const __m256i vl_lo = _mm256_set1_epi8((char)last_lo);
	const __m256i vl_hi = _mm256_set1_epi8((char)last_hi);
	for (; i + 32 <= limit + 1; i += 32) {
		__m256i bf = _mm256_loadu_si256((const __m256i*)(hay + i));
		__m256i bl = _mm256_loadu_si256((const __m256i*)(hay + i + needle_len - 1));
		__m256i mf = _mm256_or_si256(_mm256_cmpeq_epi8(bf, vf_lo), _mm256_cmpeq_epi8(bf, vf_hi));
		__m256i ml = _mm256_or_si256(_mm256_cmpeq_epi8(bl, vl_lo), _mm256_cmpeq_epi8(bl, vl_hi));
		uint32_t mask = (uint32_t)_mm256_movemask_epi8(_mm256_and_si256(mf, ml));
		while (mask != 0) {
#if defined(__GNUC__) || defined(__clang__)
			uint32_t bit = (uint32_t)__builtin_ctz(mask);
#else
			uint32_t bit = 0;
			while (((mask >> bit) & 1u) == 0) bit++;
#endif
			size_t pos = i + bit;
			size_t k = 1;
			for (; k + 1 < needle_len; k++) {
				if (ascii_tolower(hay[pos + k]) != needle_lower[k]) break;
			}
			if (k + 1 >= needle_len) return (ptrdiff_t)pos;
			mask &= mask - 1;
		}
	}
#endif

	for (; i <= limit; i++) {
		uint8_t c0 = hay[i];
		if (c0 != first_lo && c0 != first_hi) continue;
		uint8_t cl = hay[i + needle_len - 1];
		if (cl != last_lo && cl != last_hi) continue;
		size_t k = 1;
		for (; k + 1 < needle_len; k++) {
			if (ascii_tolower(hay[i + k]) != needle_lower[k]) break;
		}
		if (k + 1 >= needle_len) return (ptrdiff_t)i;
	}
	return -1;
}

/* ============================================================================
 * 2. N-API Method: grepBufferLiteral
 *    grepBufferLiteral(buffer, needleString, ignoreCase, budget, keepChars)
 *    Returns Array<{ lineNumber: number, lineText: string }> or null if binary
 * ============================================================================ */

static napi_value js_grep_buffer_literal(napi_env env, napi_callback_info info) {
	size_t argc = 5;
	napi_value argv[5];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

	napi_value out_arr;
	napi_create_array(env, &out_arr);
	if (argc < 5) return out_arr;

	uint8_t* buf = NULL;
	size_t buf_len = 0;
	if (napi_get_buffer_info(env, argv[0], (void**)&buf, &buf_len) != napi_ok || !buf || buf_len == 0) {
		return out_arr;
	}

	char needle_stack[512];
	size_t needle_len = 0;
	napi_get_value_string_utf8(env, argv[1], NULL, 0, &needle_len);
	char* needle = needle_len < sizeof(needle_stack) ? needle_stack : (char*)malloc(needle_len + 1);
	if (!needle) return out_arr;
	napi_get_value_string_utf8(env, argv[1], needle, needle_len + 1, &needle_len);

	int ignore_case = 0;
	int32_t budget = 100;
	int32_t keep_chars = 4000;
	napi_get_value_bool(env, argv[2], &ignore_case);
	napi_get_value_int32(env, argv[3], &budget);
	napi_get_value_int32(env, argv[4], &keep_chars);

	if (ignore_case) {
		for (size_t i = 0; i < needle_len; i++) {
			needle[i] = (char)ascii_tolower((uint8_t)needle[i]);
		}
	}

	/* Quick preflight: find the first match BEFORE checking the entire buffer for NUL bytes!
	 * This saves scanning non-matching files twice. */
	ptrdiff_t at = ignore_case
		? simd_find_icase(buf, buf_len, (const uint8_t*)needle, needle_len, 0)
		: simd_find_exact(buf, buf_len, (const uint8_t*)needle, needle_len, 0);

	if (at < 0) {
		if (needle != needle_stack) free(needle);
		return out_arr;
	}

	/* Binary file check (NUL byte) only when at least one match exists */
	if (has_nul_byte_fast(buf, buf_len)) {
		if (needle != needle_stack) free(needle);
		return out_arr;
	}

	uint32_t line = 1;
	size_t counted = 0;
	uint32_t found = 0;

	while (at >= 0 && (int32_t)found < budget) {
		size_t pos = (size_t)at;
		/* Find start of line */
		size_t start = pos;
		while (start > 0 && buf[start - 1] != '\n') {
			start--;
		}
		/* Find end of line */
		const void* nl_ptr = memchr(buf + pos, '\n', buf_len - pos);
		size_t end = nl_ptr ? (size_t)((const uint8_t*)nl_ptr - buf) : buf_len;

		line += count_newlines_fast(buf, counted, start);
		counted = start;

		size_t slice_end = end;
		if (slice_end > start && buf[slice_end - 1] == '\r') {
			slice_end--;
		}
		size_t max_bytes = (size_t)keep_chars;
		if (slice_end - start > max_bytes) {
			slice_end = start + max_bytes;
		}

		napi_value item, v_line, v_text;
		napi_create_object(env, &item);
		napi_create_int32(env, (int32_t)line, &v_line);
		napi_create_string_utf8(env, (const char*)(buf + start), slice_end - start, &v_text);
		napi_set_named_property(env, item, "lineNumber", v_line);
		napi_set_named_property(env, item, "lineText", v_text);
		napi_set_element(env, out_arr, found++, item);

		if (end >= buf_len) break;
		at = ignore_case
			? simd_find_icase(buf, buf_len, (const uint8_t*)needle, needle_len, end + 1)
			: simd_find_exact(buf, buf_len, (const uint8_t*)needle, needle_len, end + 1);
	}

	if (needle != needle_stack) free(needle);
	return out_arr;
}

/* ============================================================================
 * 3. Smith-Waterman / fff-style Fuzzy Scorer with Bitmask Prefilter
 *    fuzzyFilterPaths(pathsArray, queryString, limit)
 *    Returns Array<string> sorted by score descending
 * ============================================================================ */

static int score_fuzzy_path(const char* path_str, size_t path_len, const char* query_lower, size_t q_len, uint64_t q_mask) {
	if (q_len == 0) return 1;
	if (path_len < q_len) return 0;

	/* Fast single-pass bitmask + subsequence check while finding last '/' */
	uint64_t p_mask = 0;
	size_t last_slash = 0;
	int has_slash = 0;
	size_t qi = 0;
	for (size_t i = 0; i < path_len; i++) {
		uint8_t c = ascii_tolower((uint8_t)path_str[i]);
		if (c == '/') {
			last_slash = i;
			has_slash = 1;
		} else if (c >= 'a' && c <= 'z') {
			p_mask |= (1ULL << (c - 'a'));
		} else if (c >= '0' && c <= '9') {
			p_mask |= (1ULL << (26 + (c - '0')));
		}
		if (qi < q_len && c == (uint8_t)query_lower[qi]) {
			qi++;
		}
	}
	if ((p_mask & q_mask) != q_mask || qi < q_len) return 0; /* Missing chars or not a subsequence */

	size_t base_start = has_slash ? last_slash + 1 : 0;
	int score = 100;

	/* Greedy forward boundary-aware alignment */
	size_t search_from = 0;
	size_t prev_match = (size_t)-1;
	int matched_in_basename = 0;

	for (size_t k = 0; k < q_len; k++) {
		uint8_t qc = (uint8_t)query_lower[k];
		size_t best_pos = (size_t)-1;
		int best_bonus = -1000;

		for (size_t i = search_from; i <= path_len - (q_len - k); i++) {
			if (ascii_tolower((uint8_t)path_str[i]) != qc) continue;
			int bonus = 0;
			if (prev_match != (size_t)-1 && i == prev_match + 1) {
				bonus += 35; /* Consecutive character bonus */
			}
			if (i == base_start) {
				bonus += 50; /* Start of filename bonus */
			} else if (i > 0) {
				char prev_c = path_str[i - 1];
				if (prev_c == '/' || prev_c == '_' || prev_c == '-' || prev_c == '.') {
					bonus += 28; /* Word boundary bonus */
				} else if (prev_c >= 'a' && prev_c <= 'z' && path_str[i] >= 'A' && path_str[i] <= 'Z') {
					bonus += 24; /* camelCase boundary bonus */
				}
			}
			if (i >= base_start) {
				bonus += 15; /* Filename match bonus */
			}
			if (bonus > best_bonus) {
				best_bonus = bonus;
				best_pos = i;
				if (bonus >= 50) break;
			}
		}

		if (best_pos == (size_t)-1) return 0;
		score += 20 + best_bonus;
		if (prev_match != (size_t)-1 && best_pos > prev_match + 1) {
			score -= (int)(best_pos - prev_match - 1) * 2; /* Gap penalty */
		}
		if (best_pos >= base_start) matched_in_basename++;
		prev_match = best_pos;
		search_from = best_pos + 1;
	}

	/* Prefer shorter paths and full basename matches */
	score -= (int)(path_len / 4);
	if ((size_t)matched_in_basename == q_len && (path_len - base_start) == q_len) {
		score += 80; /* Exact filename match */
	}
	return score > 0 ? score : 1;
}

typedef struct {
	uint32_t index;
	int score;
} ScoredItem;

static int compare_scored_items(const void* a, const void* b) {
	const ScoredItem* sa = (const ScoredItem*)a;
	const ScoredItem* sb = (const ScoredItem*)b;
	if (sb->score != sa->score) return sb->score - sa->score;
	return (sa->index < sb->index) ? -1 : (sa->index > sb->index ? 1 : 0);
}

static napi_value js_fuzzy_filter_paths(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value argv[3];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

	napi_value out_arr;
	napi_create_array(env, &out_arr);
	if (argc < 3) return out_arr;

	uint32_t path_count = 0;
	if (napi_get_array_length(env, argv[0], &path_count) != napi_ok || path_count == 0) {
		return out_arr;
	}

	char query[256];
	size_t q_len = 0;
	napi_get_value_string_utf8(env, argv[1], query, sizeof(query), &q_len);
	uint64_t q_mask = 0;
	for (size_t i = 0; i < q_len; i++) {
		uint8_t c = ascii_tolower((uint8_t)query[i]);
		query[i] = (char)c;
		if (c >= 'a' && c <= 'z') q_mask |= (1ULL << (c - 'a'));
		else if (c >= '0' && c <= '9') q_mask |= (1ULL << (26 + (c - '0')));
	}

	int32_t limit = 100;
	napi_get_value_int32(env, argv[2], &limit);
	if (limit <= 0) return out_arr;

	ScoredItem* matches = (ScoredItem*)malloc(sizeof(ScoredItem) * path_count);
	if (!matches) return out_arr;
	uint32_t match_count = 0;

	char path_buf[1024];
	for (uint32_t i = 0; i < path_count; i++) {
		napi_value elem;
		if (napi_get_element(env, argv[0], i, &elem) != napi_ok) continue;
		size_t p_len = 0;
		napi_get_value_string_utf8(env, elem, path_buf, sizeof(path_buf), &p_len);
		int sc = score_fuzzy_path(path_buf, p_len, query, q_len, q_mask);
		if (sc > 0) {
			matches[match_count].index = i;
			matches[match_count].score = sc;
			match_count++;
		}
	}

	qsort(matches, match_count, sizeof(ScoredItem), compare_scored_items);
	uint32_t result_count = match_count < (uint32_t)limit ? match_count : (uint32_t)limit;

	for (uint32_t i = 0; i < result_count; i++) {
		napi_value elem;
		napi_get_element(env, argv[0], matches[i].index, &elem);
		napi_set_element(env, out_arr, i, elem);
	}

	free(matches);
	return out_arr;
}

/* Zero-crossing flat-buffer fuzzy search:
 * fuzzyFilterPackedPaths(packedBuffer, queryString, limit)
 * packedBuffer is NUL-delimited UTF-8 strings ("src/a.ts\0src/b.ts\0").
 * Returns Array<number> of matched indices sorted by score descending! */
static napi_value js_fuzzy_filter_packed_paths(napi_env env, napi_callback_info info) {
	size_t argc = 3;
	napi_value argv[3];
	napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

	napi_value out_arr;
	napi_create_array(env, &out_arr);
	if (argc < 3) return out_arr;

	const char* buf = NULL;
	size_t buf_len = 0;
	if (napi_get_buffer_info(env, argv[0], (void**)&buf, &buf_len) != napi_ok || !buf || buf_len == 0) {
		return out_arr;
	}

	char query[256];
	size_t q_len = 0;
	napi_get_value_string_utf8(env, argv[1], query, sizeof(query), &q_len);
	uint64_t q_mask = 0;
	for (size_t i = 0; i < q_len; i++) {
		uint8_t c = ascii_tolower((uint8_t)query[i]);
		query[i] = (char)c;
		if (c >= 'a' && c <= 'z') q_mask |= (1ULL << (c - 'a'));
		else if (c >= '0' && c <= '9') q_mask |= (1ULL << (26 + (c - '0')));
	}

	int32_t limit = 100;
	napi_get_value_int32(env, argv[2], &limit);
	if (limit <= 0) return out_arr;

	size_t cap = 1024;
	ScoredItem* matches = (ScoredItem*)malloc(sizeof(ScoredItem) * cap);
	if (!matches) return out_arr;
	uint32_t match_count = 0;

	size_t pos = 0;
	uint32_t idx = 0;
	while (pos < buf_len) {
		const void* nul_ptr = memchr(buf + pos, 0, buf_len - pos);
		size_t end = nul_ptr ? (size_t)((const char*)nul_ptr - buf) : buf_len;
		size_t p_len = end - pos;
		if (p_len > 0) {
			int sc = score_fuzzy_path(buf + pos, p_len, query, q_len, q_mask);
			if (sc > 0) {
				if (match_count >= cap) {
					cap *= 2;
					ScoredItem* grown = (ScoredItem*)realloc(matches, sizeof(ScoredItem) * cap);
					if (!grown) break;
					matches = grown;
				}
				matches[match_count].index = idx;
				matches[match_count].score = sc;
				match_count++;
			}
		}
		pos = end + 1;
		idx++;
	}

	qsort(matches, match_count, sizeof(ScoredItem), compare_scored_items);
	uint32_t result_count = match_count < (uint32_t)limit ? match_count : (uint32_t)limit;

	for (uint32_t i = 0; i < result_count; i++) {
		napi_value v_idx;
		napi_create_int32(env, (int32_t)matches[i].index, &v_idx);
		napi_set_element(env, out_arr, i, v_idx);
	}

	free(matches);
	return out_arr;
}

NAPI_EXPORT napi_value napi_register_module_v1(napi_env env, napi_value exports) {
	napi_property_descriptor props[] = {
		{ "grepBufferLiteral", NULL, js_grep_buffer_literal, NULL, NULL, NULL, 0, NULL },
		{ "fuzzyFilterPaths", NULL, js_fuzzy_filter_paths, NULL, NULL, NULL, 0, NULL },
		{ "fuzzyFilterPackedPaths", NULL, js_fuzzy_filter_packed_paths, NULL, NULL, NULL, 0, NULL }
	};
	napi_define_properties(env, exports, 3, props);
	return exports;
}
