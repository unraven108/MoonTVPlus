/* eslint-disable react-hooks/exhaustive-deps */
'use client';

import { useCallback, useEffect, useRef } from 'react';

// 通用视频列表滚动位置保存/恢复 hook。
//
// 解决"从详情/播放页返回列表页后，列表滚动位置丢失"问题。
// 原理：
//  - 滚动时（节流）/组件卸载时/跳转前，把 window.scrollY 写入 sessionStorage
//    （key 含筛选条件，不同筛选互不干扰）；
//  - 进入页面（列表数据就绪）或 popstate/pageshow（Next 组件复用返回）时，
//    轮询等待页面高度足够后恢复滚动位置；到达后稳定一段时间才算完成，
//    防止被导航后的滚动重置覆盖。完成后重置状态，允许下次（如切回同筛选）再恢复。
//
// 注意：本项目滚动容器是文档级（html/body），因此读取 window.scrollY /
// documentElement.scrollTop / body.scrollTop。

interface UseListScrollRestorationOptions {
  /** 存储前缀，用于区分不同页面，如 'douban' */
  prefix: string;
  /** 返回当前筛选条件的 key（不同筛选互不干扰） */
  getFilterKey: () => string;
  /** 是否可恢复（列表数据已就绪，true 时触发恢复） */
  ready: boolean;
}

export function useListScrollRestoration({
  prefix,
  getFilterKey,
  ready,
}: UseListScrollRestorationOptions) {
  // 通过 ref 持有最新 getFilterKey，避免渲染期间闭包过期
  const filterKeyRef = useRef(getFilterKey);
  filterKeyRef.current = getFilterKey;

  // 是否有恢复正在进行中（防重入）
  const restoringRef = useRef(false);
  // 已恢复过的 key（防止同 key 重复恢复）
  const restoredKeyRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  // 挂载初期（数据就绪前）抑制 scroll 事件保存：Next 返回时的内置滚动恢复
  // 会触发 scroll 事件并可能把钳制后的错误位置写进 sessionStorage，覆盖目标值。
  // 5 秒后（正常浏览阶段）恢复保存；onBeforeNavigate 的显式保存不受此限制。
  const suppressScrollSaveRef = useRef(true);

  const getScrollY = useCallback(() => {
    if (typeof window === 'undefined') return 0;
    return (
      window.scrollY ||
      window.pageYOffset ||
      document.documentElement.scrollTop ||
      document.body.scrollTop ||
      0
    );
  }, []);

  // 同时设置 window / documentElement / body 的滚动位置：
  // 不同页面/布局下滚动容器可能是 document 级（html/body），
  // 仅用 window.scrollTo 在 body 作为滚动容器时可能无效。
  const setScrollY = useCallback((y: number) => {
    if (typeof window === 'undefined') return;
    window.scrollTo(0, y);
    if (document.documentElement) document.documentElement.scrollTop = y;
    if (document.body) document.body.scrollTop = y;
  }, []);

  const dbg = useCallback((...args: unknown[]) => {
    if (typeof window !== 'undefined') {
      // eslint-disable-next-line no-console
      console.log('[scroll-restore]', ...args);
    }
  }, []);

  const buildStorageKey = useCallback(() => {
    return `${prefix}:scroll:${filterKeyRef.current()}`;
  }, [prefix]);

  // 保存当前滚动位置
  const saveScroll = useCallback(() => {
    if (typeof window === 'undefined') return;
    // 恢复进行中不保存，防止把恢复过程中的中间位置写回存储
    if (restoringRef.current) return;
    const y = getScrollY();
    if (y <= 0) return;
    const key = buildStorageKey();
    try {
      sessionStorage.setItem(key, String(y));
      dbg('save', key, y);
    } catch {
      // sessionStorage 不可用时静默忽略
    }
  }, [buildStorageKey, getScrollY, dbg]);

  // 恢复滚动位置（挂载就绪 effect 与 popstate/pageshow 共用）
  const restoreScroll = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (restoringRef.current) {
      dbg('restore skip: restoring in progress', buildStorageKey());
      return;
    }

    const key = buildStorageKey();
    if (restoredKeyRef.current === key) {
      dbg('restore skip: already restored', key);
      return;
    }

    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
    } catch {
      return;
    }
    if (!raw) {
      dbg('restore: no saved value', key);
      return;
    }

    const targetY = Number.parseInt(raw, 10);
    if (!Number.isFinite(targetY) || targetY <= 0) {
      dbg('restore: invalid value', key, raw);
      return;
    }

    dbg('restore: starting', key, 'target', targetY);
    restoredKeyRef.current = key;
    restoringRef.current = true;

    let attempts = 0;
    let stable = 0;
    let lastMaxY = -1;
    let heightStableCount = 0;

    if (timerRef.current != null) {
      window.clearInterval(timerRef.current);
    }
    timerRef.current = window.setInterval(() => {
      attempts += 1;
      if (attempts > 200) {
        // 20s 超时：尽力恢复到当前最大可滚动位置（避免页面高度不足时停在顶部）
        const fallbackMaxY = Math.max(
          0,
          Math.max(
            document.documentElement.scrollHeight || 0,
            document.body.scrollHeight || 0
          ) - window.innerHeight
        );
        if (fallbackMaxY > 0) {
          setScrollY(fallbackMaxY);
          dbg('restore: timeout fallback', key, 'target', targetY, 'maxY', fallbackMaxY);
        } else {
          dbg('restore: timeout', key, 'target', targetY, 'scrollY', getScrollY());
        }
        restoringRef.current = false;
        restoredKeyRef.current = null;
        if (timerRef.current != null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return;
      }

      const maxY = Math.max(
        0,
        Math.max(
          document.documentElement.scrollHeight || 0,
          document.body.scrollHeight || 0
        ) - window.innerHeight
      );

      if (maxY < targetY) {
        // 页面高度不足：等待内容撑高。若高度已连续 3 秒不再增长
        // （图片加载完成/失败、数据渲染稳定），说明无法达到目标位置，
        // 则尽力恢复到当前最大可滚动位置，避免用户停在顶部。
        if (maxY === lastMaxY) {
          heightStableCount += 1;
          if (heightStableCount >= 30) {
            if (maxY > 0) {
              setScrollY(maxY);
              dbg('restore: height stable, fallback to maxY', key, 'target', targetY, 'maxY', maxY);
            } else {
              dbg('restore: height stable but maxY=0', key, 'target', targetY);
            }
            restoringRef.current = false;
            restoredKeyRef.current = null;
            if (timerRef.current != null) {
              window.clearInterval(timerRef.current);
              timerRef.current = null;
            }
          }
        } else {
          lastMaxY = maxY;
          heightStableCount = 0;
        }
        return;
      }

      const currentY = getScrollY();

      if (Math.abs(currentY - targetY) < 8) {
        // 已到达目标：稳定 500ms 才算完成（防止被导航后的滚动重置覆盖）
        stable += 1;
        if (stable >= 5) {
          dbg('restore: done', key, 'target', targetY);
          restoringRef.current = false;
          restoredKeyRef.current = null;
          if (timerRef.current != null) {
            window.clearInterval(timerRef.current);
            timerRef.current = null;
          }
        }
        return;
      }

      // 无论当前位置如何都恢复到目标位置：
      // 返回场景中 Next 可能把滚动钳制到中间值（非顶部），
      // 不能据此判断"用户主动滚动"而放弃恢复。
      stable = 0;
      dbg('restore: scrollTo', key, 'target', targetY, 'current', currentY, 'maxY', maxY);
      setScrollY(targetY);
    }, 100);
  }, [buildStorageKey, getScrollY, setScrollY, dbg]);

  // 滚动节流保存 + 卸载时保存并清理
  useEffect(() => {
    let debounceTimer: number | null = null;

    const handleScroll = () => {
      // 挂载初期抑制 scroll 保存：防止 Next 返回时的内置滚动恢复
      // 触发 scroll 事件把错误位置写进存储
      if (suppressScrollSaveRef.current) return;
      if (debounceTimer != null) return;
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        saveScroll();
      }, 300);
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (debounceTimer != null) {
        window.clearTimeout(debounceTimer);
      }
      saveScroll(); // 卸载时保存当前滚动位置
      if (timerRef.current != null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [saveScroll]);

  // 挂载 5 秒后恢复 scroll 事件保存（此时 Next 内置滚动恢复已完成）
  useEffect(() => {
    const t = window.setTimeout(() => {
      suppressScrollSaveRef.current = false;
    }, 5000);
    return () => window.clearTimeout(t);
  }, []);

  // 挂载时即尝试恢复（不依赖数据就绪）：
  // 返回后若数据加载慢/失败，ready 可能一直为 false，导致恢复永不触发。
  // 轮询本身会等待页面高度，因此只需 sessionStorage 有值即可开始。
  useEffect(() => {
    restoreScroll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 列表数据就绪后恢复（处理重新挂载 / 筛选切换后数据加载完成）
  useEffect(() => {
    if (!ready) return;
    dbg('ready=true, calling restoreScroll', buildStorageKey());
    restoreScroll();
  }, [ready, restoreScroll, dbg, buildStorageKey]);

  // popstate / pageshow 恢复（处理 Next 组件复用返回场景）
  useEffect(() => {
    const handleRestore = () => {
      dbg('popstate/pageshow fired, calling restoreScroll', buildStorageKey());
      restoreScroll();
    };
    window.addEventListener('popstate', handleRestore);
    window.addEventListener('pageshow', handleRestore);
    return () => {
      window.removeEventListener('popstate', handleRestore);
      window.removeEventListener('pageshow', handleRestore);
    };
  }, [restoreScroll, dbg, buildStorageKey]);

  return { saveScroll };
}
