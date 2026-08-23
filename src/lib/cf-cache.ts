/**
 * 轻量边缘缓存（基于 Cloudflare Cache API）
 * 用于缓存上游视频源接口的响应，减少重复请求、加快页面响应。
 * 缓存不可用时自动降级为直接请求，不影响功能。
 */

const g = globalThis as unknown as {
  caches?: {
    default?: {
      match: (req: Request) => Promise<Response | undefined>;
      put: (req: Request, res: Response) => Promise<void>;
    };
  };
};

export interface CacheResult<T> {
  status: number;
  json: T;
}

/**
 * 先查缓存，未命中则执行 fetcher 获取数据并写入缓存。
 * 仅当 fetcher 返回 200 时写缓存。
 *
 * @param keyUrl 用于缓存的 URL（不同参数应生成不同 URL，用于区分缓存条目）
 * @param ttlSeconds 缓存时长（秒），通过响应头 Cache-Control: s-maxage 控制过期
 * @param fetcher 数据获取函数，返回状态码与数据
 */
export async function cachedFetch<T>(
  keyUrl: string,
  ttlSeconds: number,
  fetcher: () => Promise<CacheResult<T>>
): Promise<CacheResult<T>> {
  const cache = g.caches?.default;

  // 读缓存
  if (cache) {
    try {
      const hit = await cache.match(new Request(keyUrl));
      if (hit && hit.ok) {
        return { status: hit.status, json: (await hit.json()) as T };
      }
    } catch {
      // 读缓存失败则忽略，走真实请求
    }
  }

  const result = await fetcher();

  // 写缓存（仅成功响应）
  if (cache && result.status === 200) {
    try {
      const response = new Response(JSON.stringify(result.json), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, s-maxage=${ttlSeconds}, max-age=0`,
        },
      });
      await cache.put(new Request(keyUrl), response);
    } catch {
      // 写缓存失败不影响响应
    }
  }

  return result;
}
