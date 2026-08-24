'use client';

import { useEffect, useRef, useState } from 'react';

// 通用会话级状态持久化 hook：
// 解决"从详情/播放页返回列表页后，筛选/搜索/分页状态丢失"问题。
// 状态挂载后从 sessionStorage 恢复，变化时写入；返回时组件重挂载也能还原。
//
// 注意：不在 useState initializer 里读 sessionStorage，避免 SSR/hydration mismatch；
// 恢复放在挂载后的 useEffect 中。

function buildKey(name: string, customKey?: string): string {
  if (customKey) return `page-state:${customKey}`;
  if (typeof window === 'undefined') return `page-state:${name}`;
  return `page-state:${window.location.pathname}:${name}`;
}

export function usePersistedState<T>(
  name: string,
  initial: T | (() => T),
  options?: { key?: string }
): [T, React.Dispatch<React.SetStateAction<T>>] {
  // 首次渲染的 key 固定（后续自定义 key 变化时不再重新恢复，避免覆盖 type 切换后的值）
  const storageKeyRef = useRef<string>(buildKey(name, options?.key));
  storageKeyRef.current = buildKey(name, options?.key);

  const [state, setState] = useState<T>(() =>
    typeof initial === 'function' ? (initial as () => T)() : initial
  );

  const stateRef = useRef(state);
  stateRef.current = state;

  // 挂载后从 sessionStorage 恢复（只执行一次）
  useEffect(() => {
    let alive = true;
    try {
      const raw = sessionStorage.getItem(storageKeyRef.current);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as T;
        if (alive) setState(parsed);
      }
    } catch {
      // 忽略损坏的缓存
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 状态变化时写回 sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKeyRef.current, JSON.stringify(stateRef.current));
    } catch {
      // sessionStorage 不可用时静默忽略
    }
  }, [state]);

  return [state, setState];
}
