// Lock-free atomics for SottoAudio's real-time rings (docs/NATIVE.md §5.3).
// Swift's Synchronization.Atomic needs macOS 15; the app targets macOS 14, so the
// render thread uses these C11 builtins instead (no locks, no allocation).
#pragma once
#include <stdint.h>

static inline int64_t sotto_atomic_load(const int64_t *p) { return __atomic_load_n(p, __ATOMIC_ACQUIRE); }
static inline void sotto_atomic_store(int64_t *p, int64_t v) { __atomic_store_n(p, v, __ATOMIC_RELEASE); }
static inline int64_t sotto_atomic_add(int64_t *p, int64_t v) { return __atomic_fetch_add(p, v, __ATOMIC_ACQ_REL); }
static inline int64_t sotto_atomic_exchange(int64_t *p, int64_t v) { return __atomic_exchange_n(p, v, __ATOMIC_ACQ_REL); }
