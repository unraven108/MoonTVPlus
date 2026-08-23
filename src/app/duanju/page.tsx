/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
'use client';

import { ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { SearchResult } from '@/lib/types';

import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

interface DuanjuSource {
  key: string;
  name: string;
  api: string;
  typeId?: string;
  typeName?: string;
}

// ---- 视频列表缓存（sessionStorage），用于从播放页返回时恢复 ----
interface DuanjuCacheData {
  videos: SearchResult[];
  currentPage: number;
  hasMore: boolean;
  scrollY: number;
}

const CACHE_PREFIX = 'duanju-cache:';

function readCache(source: string, key: string): DuanjuCacheData | null {
  try {
    const raw = sessionStorage.getItem(`${CACHE_PREFIX}${source}:${key}`);
    return raw ? (JSON.parse(raw) as DuanjuCacheData) : null;
  } catch {
    return null;
  }
}

function writeCache(source: string, key: string, data: DuanjuCacheData) {
  try {
    sessionStorage.setItem(`${CACHE_PREFIX}${source}:${key}`, JSON.stringify(data));
  } catch {
    // sessionStorage 不可用时静默忽略
  }
}

function DuanjuPageClient() {
  const router = useRouter();
  // 首次挂载不替换 URL，保留原始参数
  const initializedRef = useRef(false);
  const hasSyncedRef = useRef(false);
  // 已尝试恢复缓存的 key，避免重复恢复
  const restoredCacheKeyRef = useRef<string | null>(null);
  // 恢复缓存后用于跳过因 currentPage 变化触发的重复请求
  const restoredPageRef = useRef<number | null>(null);
  // 待恢复的滚动位置
  const pendingScrollRef = useRef<number | null>(null);
  // 初始 URL 参数
  const urlSourceRef = useRef('');
  const urlCategoryRef = useRef('');
  const urlPageRef = useRef(1);

  const [sources, setSources] = useState<DuanjuSource[]>([]);
  const [selectedSource, setSelectedSource] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const [videos, setVideos] = useState<SearchResult[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const sourceScrollContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftRef = useRef(0);

  // ---- 挂载时从 URL 恢复初始状态（source/category/page） ----
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    urlSourceRef.current = params.get('source') || '';
    urlCategoryRef.current = params.get('category') || '';
    urlPageRef.current = parseInt(params.get('page') || '1', 10) || 1;
    if (urlPageRef.current > 1) {
      setCurrentPage(urlPageRef.current);
    }
  }, []);

  // ---- 状态变化时同步到 URL，返回/刷新时保持状态 ----
  useEffect(() => {
    if (!hasSyncedRef.current) {
      hasSyncedRef.current = true;
      return; // 首次挂载不替换 URL，保留原始参数
    }
    if (!selectedSource || !selectedCategory) return;
    const params = new URLSearchParams();
    params.set('source', selectedSource);
    params.set('category', selectedCategory);
    if (currentPage > 1) params.set('page', String(currentPage));
    router.replace(`/duanju?${params.toString()}`, { scroll: false });
  }, [selectedSource, selectedCategory, currentPage, router]);

  useEffect(() => {
    const fetchSources = async () => {
      setIsLoadingSources(true);
      try {
        const response = await fetch('/api/duanju/sources');
        const data = await response.json();
        if (data.code === 200 && Array.isArray(data.data)) {
          setSources(data.data);
          if (data.data.length > 0) {
            // 优先选择 URL 中指定的源，否则默认第一个
            const urlSource = urlSourceRef.current;
            const valid = data.data.find((s: DuanjuSource) => s.key === urlSource);
            const src = valid || data.data[0];
            setSelectedSource(src.key);
            setSelectedCategory(urlCategoryRef.current || src.typeId || '');
          }
        }
      } catch (error) {
        console.error('Failed to load duanju sources:', error);
      } finally {
        setIsLoadingSources(false);
      }
    };

    fetchSources();
  }, []);

  const handleSourceChange = (sourceKey: string) => {
    const source = sources.find((item) => item.key === sourceKey);
    setSelectedSource(sourceKey);
    setSelectedCategory(source?.typeId || '');
    setCurrentPage(1);
    setVideos([]);
    setHasMore(true);
  };

  useEffect(() => {
    if (!selectedSource || !selectedCategory) return;

    const cacheKey = `${selectedSource}:${selectedCategory}`;

    // 列表为空时，尝试从缓存恢复（从播放页返回/刷新场景）
    if (videos.length === 0 && restoredCacheKeyRef.current !== cacheKey) {
      restoredCacheKeyRef.current = cacheKey;
      const cached = readCache(selectedSource, selectedCategory);
      if (cached && cached.videos.length > 0) {
        // 恢复页码（如果与 URL 中的 page 不一致）
        if (cached.currentPage !== currentPage) {
          restoredPageRef.current = cached.currentPage;
          setCurrentPage(cached.currentPage);
        }
        setVideos(cached.videos);
        setHasMore(cached.hasMore);
        // 恢复滚动位置（由常驻滚动监视器执行）
        pendingScrollRef.current = cached.scrollY;
        return; // 跳过 fetch
      }
    }

    // 如果刚刚恢复了缓存且页码已同步，跳过因 currentPage 变化触发的 fetch
    if (restoredPageRef.current !== null && restoredPageRef.current === currentPage && videos.length > 0) {
      restoredPageRef.current = null;
      return;
    }

    const fetchVideos = async () => {
      setIsLoadingVideos(true);
      try {
        const response = await fetch(
          `/api/duanju/videos?source=${encodeURIComponent(selectedSource)}&categoryId=${encodeURIComponent(selectedCategory)}&page=${currentPage}`
        );
        const data = await response.json();
        if (data.code === 200 && Array.isArray(data.data)) {
          if (currentPage === 1) {
            setVideos(data.data);
          } else {
            setVideos((prev) => [...prev, ...data.data]);
          }
          setHasMore(data.page < data.pageCount);
        }
      } catch (error) {
        console.error('Failed to load duanju videos:', error);
      } finally {
        setIsLoadingVideos(false);
      }
    };

    fetchVideos();
  }, [selectedSource, selectedCategory, currentPage]);

  useEffect(() => {
    if (!loadMoreRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && hasMore && !isLoadingVideos) {
          setCurrentPage((prev) => prev + 1);
        }
      },
      { rootMargin: '240px 0px', threshold: 0.1 }
    );

    observer.observe(loadMoreRef.current);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, isLoadingVideos]);

  // 跳转播放页前保存当前状态到缓存，供返回时恢复
  const saveStateToCache = () => {
    if (videos.length === 0 || !selectedSource || !selectedCategory) return;
    writeCache(selectedSource, selectedCategory, {
      videos,
      currentPage,
      hasMore,
      scrollY: window.scrollY,
    });
  };

  // ---- 恢复滚动位置（常驻监视器）----
  // 不依赖 videos 渲染时序：只要恢复缓存时设置了 pendingScrollRef，
  // 就每 100ms 尝试滚动到目标，页面高度足够且到达目标即完成；超时（3 秒）放弃。
  useEffect(() => {
    let attempts = 0;
    const timer = setInterval(() => {
      const targetY = pendingScrollRef.current;
      if (targetY === null) return;
      attempts++;
      if (attempts > 30) {
        pendingScrollRef.current = null;
        return;
      }
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      if (maxY < targetY) return; // 图片懒加载未撑开页面，继续等待
      window.scrollTo(0, targetY);
      if (Math.abs(window.scrollY - targetY) < 8) {
        pendingScrollRef.current = null; // 到达目标
      }
    }, 100);
    return () => clearInterval(timer);
  }, []);

  // 从播放页返回（浏览器后退）时，若组件实例被 Next.js 复用而未重新挂载，
  // 上面的恢复逻辑不会重新运行；pageshow 时从缓存补一次滚动恢复。
  useEffect(() => {
    const onPageShow = () => {
      if (videos.length === 0 || pendingScrollRef.current !== null) return;
      if (!selectedSource || !selectedCategory) return;
      const cached = readCache(selectedSource, selectedCategory);
      if (cached && cached.scrollY > 0) {
        pendingScrollRef.current = cached.scrollY;
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [videos, selectedSource, selectedCategory]);

  return (
    <PageLayout activePath='/duanju'>
      <div className='px-4 sm:px-10 py-4 sm:py-8 overflow-visible mb-10'>
        <div className='mb-6 flex items-start justify-between gap-4'>
          <div>
            <h1 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
              短剧
            </h1>
            <p className='text-sm text-gray-500 dark:text-gray-400 mt-1'>
              浏览所有采集源中的短剧内容
            </p>
          </div>
          <Link
            href='/'
            className='inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100'
          >
            <ArrowLeft className='h-4 w-4' />
            返回首页
          </Link>
        </div>

        <div className='max-w-4xl mx-auto mb-8'>
          <div className='relative'>
            <div className='text-xs text-gray-500 dark:text-gray-400 mb-2 px-4'>
              服务
            </div>
            {isLoadingSources ? (
              <div className='flex items-center justify-center h-12 bg-gray-50/80 rounded-lg border border-gray-200/50 dark:bg-gray-800 dark:border-gray-700'>
                <Loader2 className='h-5 w-5 animate-spin text-gray-400' />
                <span className='ml-2 text-sm text-gray-500 dark:text-gray-400'>
                  加载采集源中...
                </span>
              </div>
            ) : sources.length === 0 ? (
              <div className='flex items-center justify-center h-12 bg-gray-50/80 rounded-lg border border-gray-200/50 dark:bg-gray-800 dark:border-gray-700'>
                <span className='text-sm text-gray-500 dark:text-gray-400'>
                  暂无包含短剧分类的采集源
                </span>
              </div>
            ) : (
              <div className='relative'>
                <div
                  ref={sourceScrollContainerRef}
                  className='overflow-x-auto scrollbar-hide cursor-grab active:cursor-grabbing'
                  onMouseDown={(e) => {
                    if (!sourceScrollContainerRef.current) return;
                    isDraggingRef.current = true;
                    startXRef.current = e.pageX - sourceScrollContainerRef.current.offsetLeft;
                    scrollLeftRef.current = sourceScrollContainerRef.current.scrollLeft;
                    sourceScrollContainerRef.current.style.cursor = 'grabbing';
                    sourceScrollContainerRef.current.style.userSelect = 'none';
                  }}
                  onMouseLeave={() => {
                    if (!sourceScrollContainerRef.current) return;
                    isDraggingRef.current = false;
                    sourceScrollContainerRef.current.style.cursor = 'grab';
                    sourceScrollContainerRef.current.style.userSelect = 'auto';
                  }}
                  onMouseUp={() => {
                    if (!sourceScrollContainerRef.current) return;
                    isDraggingRef.current = false;
                    sourceScrollContainerRef.current.style.cursor = 'grab';
                    sourceScrollContainerRef.current.style.userSelect = 'auto';
                  }}
                  onMouseMove={(e) => {
                    if (!isDraggingRef.current || !sourceScrollContainerRef.current) return;
                    e.preventDefault();
                    const x = e.pageX - sourceScrollContainerRef.current.offsetLeft;
                    const walk = (x - startXRef.current) * 2;
                    sourceScrollContainerRef.current.scrollLeft = scrollLeftRef.current - walk;
                  }}
                >
                  <div className='flex gap-2 px-4 min-w-min'>
                    {sources.map((source) => (
                      <button
                        key={source.key}
                        onClick={() => handleSourceChange(source.key)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                          selectedSource === source.key
                            ? 'bg-blue-600 text-white'
                            : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                        }`}
                      >
                        {source.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {selectedSource && !selectedCategory && (
          <div className='text-center text-gray-500 py-8 dark:text-gray-400'>
            当前采集源暂无短剧分类
          </div>
        )}

        {selectedSource && selectedCategory && (
          <div className='max-w-[95%] mx-auto mt-8'>
            <div className='mb-4'>
              <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                短剧列表
              </h2>
            </div>

            {isLoadingVideos && currentPage === 1 ? (
              <div className='flex justify-center items-center h-40'>
                <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500'></div>
              </div>
            ) : videos.length === 0 ? (
              <div className='text-center text-gray-500 py-8 dark:text-gray-400'>
                暂无短剧
              </div>
            ) : (
              <>
                <div className='grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                  {videos.map((item) => (
                    <div key={`${item.source}-${item.id}`} className='w-full'>
                      <VideoCard
                        id={item.id}
                        title={item.title}
                        poster={item.poster}
                        episodes={item.episodes.length}
                        source={item.source}
                        source_name={item.source_name}
                        douban_id={item.douban_id}
                        year={item.year}
                        from='source-search'
                        type='tv'
                        isDuanju
                        onBeforeNavigate={saveStateToCache}
                        cmsData={{
                          desc: item.desc,
                          episodes: item.episodes,
                          episodes_titles: item.episodes_titles,
                        }}
                      />
                    </div>
                  ))}
                </div>

                <div ref={loadMoreRef} className='flex justify-center items-center py-8'>
                  {isLoadingVideos && (
                    <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500'></div>
                  )}
                  {!hasMore && videos.length > 0 && (
                    <span className='text-sm text-gray-500 dark:text-gray-400'>
                      没有更多了
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </PageLayout>
  );
}

export default function DuanjuPage() {
  return (
    <Suspense>
      <DuanjuPageClient />
    </Suspense>
  );
}
