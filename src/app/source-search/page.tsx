/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */
'use client';

import { Loader2, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { isAnimeCategoryText } from '@/lib/anime-keyword-expr';
import { ApiSite } from '@/lib/config';
import { appendSpecialSourceParam } from '@/lib/special-source.client';
import { SearchResult } from '@/lib/types';

import CapsuleSwitch from '@/components/CapsuleSwitch';
import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

interface Category {
  id: string;
  name: string;
}

type ViewMode = 'browse' | 'search';

// ---- 视频列表缓存（sessionStorage），用于从播放页返回时恢复 ----
interface VideoCacheData {
  videos: SearchResult[];
  currentPage: number;
  hasMore: boolean;
  scrollY: number;
}

const CACHE_PREFIX = 'source-search-cache:';

function getCacheKey(source: string, key: string) {
  return `${CACHE_PREFIX}${source}:${key}`;
}

function readCache(source: string, key: string): VideoCacheData | null {
  try {
    const raw = sessionStorage.getItem(getCacheKey(source, key));
    return raw ? (JSON.parse(raw) as VideoCacheData) : null;
  } catch {
    return null;
  }
}

function writeCache(source: string, key: string, data: VideoCacheData) {
  try {
    sessionStorage.setItem(getCacheKey(source, key), JSON.stringify(data));
  } catch {
    // sessionStorage 不可用时静默忽略
  }
}


function SourceSearchPageClient() {
  const router = useRouter();
  const initializedRef = useRef(false);
  // 首次挂载不替换 URL，保留原始参数
  const hasSyncedRef = useRef(false);
  // 已尝试恢复缓存的 key（source:category 或 search:source:keyword），避免重复恢复
  const restoredCacheKeyRef = useRef<string | null>(null);
  // 恢复缓存后用于跳过因 currentPage 变化触发的重复请求
  const restoredPageRef = useRef<number | null>(null);
  // 待恢复的滚动位置，videos 渲染完成后滚动
  const pendingScrollRef = useRef<number | null>(null);
  // 初始 URL 参数
  const urlSourceRef = useRef('');
  const urlCategoryRef = useRef('');
  const urlPageRef = useRef(1);

  const [apiSites, setApiSites] = useState<ApiSite[]>([]);
  const [selectedSource, setSelectedSource] = useState<string>('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [videos, setVideos] = useState<SearchResult[]>([]);
  const [isLoadingSources, setIsLoadingSources] = useState(true);
  const [isLoadingCategories, setIsLoadingCategories] = useState(false);
  const [isLoadingVideos, setIsLoadingVideos] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('browse');
  const [searchKeyword, setSearchKeyword] = useState<string>('');
  const [searchInputValue, setSearchInputValue] = useState<string>('');
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // ---- 挂载时从 URL 恢复初始状态（source/category/page/mode/keyword） ----
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    urlSourceRef.current = params.get('source') || '';
    urlCategoryRef.current = params.get('category') || '';
    urlPageRef.current = parseInt(params.get('page') || '1', 10) || 1;
    const mode = params.get('mode');
    const keyword = params.get('keyword') || '';
    console.log('[source-search] init url params', {
      source: urlSourceRef.current,
      category: urlCategoryRef.current,
      page: urlPageRef.current,
      mode,
      keyword,
    });
    if (mode === 'search' && keyword) {
      setViewMode('search');
      setSearchKeyword(keyword);
      setSearchInputValue(keyword);
      setCurrentPage(urlPageRef.current);
    } else if (urlPageRef.current > 1) {
      // 浏览模式也从 URL 恢复页码
      setCurrentPage(urlPageRef.current);
    }
  }, []);

  // ---- 状态变化时同步到 URL，返回/刷新时保持状态 ----
  useEffect(() => {
    if (!hasSyncedRef.current) {
      hasSyncedRef.current = true;
      return; // 首次挂载不替换 URL，保留原始参数
    }
    // 初始化未完成前不覆盖 URL，避免丢失 category/page 参数
    if (!selectedSource) return;
    if (viewMode === 'browse' && !selectedCategory) return;
    if (viewMode === 'search' && !searchKeyword) return;

    const params = new URLSearchParams();
    if (selectedSource) params.set('source', selectedSource);
    if (viewMode === 'browse' && selectedCategory) {
      params.set('category', selectedCategory);
    }
    if (viewMode === 'search' && searchKeyword) {
      params.set('mode', 'search');
      params.set('keyword', searchKeyword);
    }
    if (currentPage > 1) params.set('page', String(currentPage));
    const query = params.toString();
    router.replace(`/source-search${query ? `?${query}` : ''}`, { scroll: false });
  }, [selectedSource, selectedCategory, currentPage, viewMode, searchKeyword, router]);

  // ---- 缓存浏览模式的视频列表状态 ----
  useEffect(() => {
    if (viewMode !== 'browse' || videos.length === 0 || !selectedSource || !selectedCategory) return;
    writeCache(selectedSource, selectedCategory, {
      videos,
      currentPage,
      hasMore,
      scrollY: window.scrollY,
    });
  }, [videos, currentPage, hasMore, selectedSource, selectedCategory, viewMode]);

  // ---- 缓存搜索模式的视频列表状态 ----
  useEffect(() => {
    if (viewMode !== 'search' || videos.length === 0 || !selectedSource || !searchKeyword) return;
    writeCache(selectedSource, `search:${searchKeyword}`, {
      videos,
      currentPage,
      hasMore,
      scrollY: window.scrollY,
    });
  }, [videos, currentPage, hasMore, selectedSource, searchKeyword, viewMode]);

  // 加载用户可用的视频源
  useEffect(() => {
    const fetchApiSites = async () => {
      setIsLoadingSources(true);
      try {
        const response = await fetch(appendSpecialSourceParam('/api/source-search/sources'));
        const data = await response.json();
        if (data.sources && Array.isArray(data.sources)) {
          setApiSites(data.sources);
          // 优先选择 URL 中指定的源，否则默认第一个
          const urlSource = urlSourceRef.current;
          const valid = data.sources.find((s: ApiSite) => s.key === urlSource);
          setSelectedSource(valid ? valid.key : (data.sources[0]?.key || ''));
        }
      } catch (error) {
        console.error('Failed to load API sources:', error);
      } finally {
        setIsLoadingSources(false);
      }
    };

    fetchApiSites();
  }, []);

  // 当选择的源变化时，加载分类列表
  useEffect(() => {
    if (!selectedSource) return;

    const fetchCategories = async () => {
      setIsLoadingCategories(true);
      setCategories([]);
      setSelectedCategory('');
      setVideos([]);
      setCurrentPage(1);
      setHasMore(true);
      try {
        const response = await fetch(
          appendSpecialSourceParam(`/api/source-search/categories?source=${encodeURIComponent(selectedSource)}`)
        );
        const data = await response.json();
        if (data.categories && Array.isArray(data.categories)) {
          setCategories(data.categories);
          // 优先选择 URL 中指定的分类，否则默认第一个
          const urlCategory = urlCategoryRef.current;
          const valid = data.categories.find((c: Category) => c.id === urlCategory);
          console.log('[source-search] fetchCategories done', {
            urlCategory,
            validCategory: valid?.id,
            firstCategory: data.categories[0]?.id,
          });
          setSelectedCategory(valid ? valid.id : (data.categories[0]?.id || ''));
        }
      } catch (error) {
        console.error('Failed to load categories:', error);
      } finally {
        setIsLoadingCategories(false);
      }
    };

    fetchCategories();
  }, [selectedSource]);

  // 当分类变化时，重置到第一页
  // 注意：必须声明在视频加载 effect 之前，否则会清空刚恢复的缓存列表
  useEffect(() => {
    setCurrentPage(1);
    setVideos([]);
    setHasMore(true);
  }, [selectedCategory]);

  // 当选择的分类或页码变化时，加载视频列表（浏览模式）
  useEffect(() => {
    if (viewMode !== 'browse' || !selectedSource || !selectedCategory) return;

    const cacheKey = `${selectedSource}:${selectedCategory}`;
    console.log('[source-search] browse effect', {
      selectedSource,
      selectedCategory,
      currentPage,
      videosLen: videos.length,
      restoredCacheKey: restoredCacheKeyRef.current,
      cacheKey,
      urlSource: urlSourceRef.current,
      urlCategory: urlCategoryRef.current,
    });

    // 列表为空时，尝试从缓存恢复（从播放页返回/刷新场景）
    if (videos.length === 0 && restoredCacheKeyRef.current !== cacheKey) {
      restoredCacheKeyRef.current = cacheKey;
      const cached = readCache(selectedSource, selectedCategory);
      console.log('[source-search] restore attempt', {
        cacheKey,
        cachedFound: !!cached,
        cachedVideosLen: cached?.videos.length,
        cachedPage: cached?.currentPage,
      });
      if (cached && cached.videos.length > 0) {
        // 恢复页码（如果与 URL 中的 page 不一致）
        if (cached.currentPage !== currentPage) {
          restoredPageRef.current = cached.currentPage;
          setCurrentPage(cached.currentPage);
        }
        setVideos(cached.videos);
        setHasMore(cached.hasMore);
        // 恢复滚动位置（等 videos 渲染后）
        pendingScrollRef.current = cached.scrollY;
        return; // 跳过 fetch
      }
    }

    // 如果刚刚恢复了缓存且页码已同步，跳过因 currentPage 变化触发的 fetch
    if (restoredPageRef.current !== null && restoredPageRef.current === currentPage && videos.length > 0) {
      restoredPageRef.current = null;
      return;
    }

    console.log('[source-search] fetch videos', { selectedSource, selectedCategory, currentPage });
    const fetchVideos = async () => {
      setIsLoadingVideos(true);
      try {
        const response = await fetch(
          appendSpecialSourceParam(`/api/source-search/videos?source=${encodeURIComponent(selectedSource)}&categoryId=${encodeURIComponent(selectedCategory)}&page=${currentPage}`)
        );
        const data = await response.json();
        console.log('[source-search] fetch videos result', {
          currentPage,
          resultsLen: data.results?.length,
          page: data.page,
          pageCount: data.pageCount,
        });
        if (data.results && Array.isArray(data.results)) {
          if (currentPage === 1) {
            setVideos(data.results);
          } else {
            setVideos((prev) => [...prev, ...data.results]);
          }
          setHasMore(data.page < data.pageCount);
        }
      } catch (error) {
        console.error('Failed to load videos:', error);
      } finally {
        setIsLoadingVideos(false);
      }
    };

    fetchVideos();
  }, [selectedSource, selectedCategory, currentPage, viewMode]);

  // 当搜索关键词或页码变化时，执行搜索（搜索模式）
  useEffect(() => {
    if (viewMode !== 'search' || !selectedSource || !searchKeyword) return;

    const cacheKey = `search:${selectedSource}:${searchKeyword}`;

    // 从播放页返回/刷新场景：URL 中 mode=search 与关键词一致且列表为空时，从缓存恢复
    const isUrlRestore =
      urlSourceRef.current === selectedSource &&
      window.location.search.includes('mode=search') &&
      new URLSearchParams(window.location.search).get('keyword') === searchKeyword;

    if (isUrlRestore && videos.length === 0 && restoredCacheKeyRef.current !== cacheKey) {
      restoredCacheKeyRef.current = cacheKey;
      const cached = readCache(selectedSource, `search:${searchKeyword}`);
      if (cached && cached.videos.length > 0) {
        if (cached.currentPage !== currentPage) {
          restoredPageRef.current = cached.currentPage;
          setCurrentPage(cached.currentPage);
        }
        setVideos(cached.videos);
        setHasMore(cached.hasMore);
        pendingScrollRef.current = cached.scrollY;
        return; // 跳过 fetch
      }
    }

    // 如果刚刚恢复了缓存且页码已同步，跳过因 currentPage 变化触发的 fetch
    if (restoredPageRef.current !== null && restoredPageRef.current === currentPage && videos.length > 0) {
      restoredPageRef.current = null;
      return;
    }

    const searchVideos = async () => {
      setIsLoadingVideos(true);
      try {
        const response = await fetch(
          appendSpecialSourceParam(`/api/source-search/search?source=${encodeURIComponent(selectedSource)}&keyword=${encodeURIComponent(searchKeyword)}&page=${currentPage}`)
        );
        const data = await response.json();
        if (data.results && Array.isArray(data.results)) {
          if (currentPage === 1) {
            setVideos(data.results);
          } else {
            setVideos((prev) => [...prev, ...data.results]);
          }
          setHasMore(data.page < data.pageCount);
        }
      } catch (error) {
        console.error('Failed to search videos:', error);
      } finally {
        setIsLoadingVideos(false);
      }
    };

    searchVideos();
  }, [selectedSource, searchKeyword, currentPage, viewMode]);

  // 处理搜索提交
  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInputValue.trim()) {
      setSearchKeyword(searchInputValue.trim());
      setViewMode('search');
      setCurrentPage(1);
      setVideos([]);
      setHasMore(true);
    }
  };

  // 切换回浏览模式
  const handleBackToBrowse = () => {
    setViewMode('browse');
    setSearchKeyword('');
    setSearchInputValue('');
    setCurrentPage(1);
    setVideos([]);
    setHasMore(true);
  };

  // 跳转播放页前保存当前状态到缓存，供返回时恢复
  const saveStateToCache = () => {
    if (videos.length === 0) return;
    const data = { videos, currentPage, hasMore, scrollY: window.scrollY };
    if (viewMode === 'search' && selectedSource && searchKeyword) {
      console.log('[source-search] saveStateToCache search', {
        cacheKey: `${selectedSource}:search:${searchKeyword}`,
        videosLen: videos.length,
      });
      writeCache(selectedSource, `search:${searchKeyword}`, data);
    } else if (viewMode === 'browse' && selectedSource && selectedCategory) {
      console.log('[source-search] saveStateToCache browse', {
        cacheKey: `${selectedSource}:${selectedCategory}`,
        videosLen: videos.length,
        currentPage,
      });
      writeCache(selectedSource, selectedCategory, data);
    }
  };

  // videos 渲染完成后恢复滚动位置
  // 轮询式：反复尝试滚动到目标位置，直到成功或超时。
  // 可应对图片懒加载撑高页面、Next.js 导航滚动干扰等导致一次性 scrollTo 失效的情况。
  useEffect(() => {
    if (pendingScrollRef.current === null) return;
    const targetY = pendingScrollRef.current;
    pendingScrollRef.current = null;

    let attempts = 0;
    const maxAttempts = 40; // 最多尝试 4 秒（每 100ms 一次）
    const tryScroll = () => {
      const maxY = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const clamped = Math.min(targetY, maxY);
      if (clamped > 0) {
        window.scrollTo(0, clamped);
      }
      const reached = maxY > 0 && Math.abs(window.scrollY - clamped) < 8;
      attempts++;
      if (!reached && attempts < maxAttempts) {
        setTimeout(tryScroll, 100);
      }
    };
    tryScroll();
  }, [videos]);

  // Intersection Observer for infinite scroll
  useEffect(() => {
    if (!loadMoreRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const target = entries[0];
        if (target.isIntersecting && hasMore && !isLoadingVideos) {
          setCurrentPage((prev) => prev + 1);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadMoreRef.current);

    return () => {
      observer.disconnect();
    };
  }, [hasMore, isLoadingVideos]);

  return (
    <PageLayout activePath='/source-search'>
      <div className='px-4 sm:px-10 py-4 sm:py-8 overflow-visible mb-10'>
        {/* 页面标题 */}
        <div className='mb-6'>
          <h1 className='text-2xl font-bold text-gray-800 dark:text-gray-200'>
            源站寻片
          </h1>
          <p className='text-sm text-gray-500 dark:text-gray-400 mt-1'>
            根据可用视频源浏览分类内容
          </p>
        </div>

        {/* 源选择和分类选择 */}
        <div className='max-w-4xl mx-auto mb-8 space-y-6'>
          {/* 源选择 CapsuleSwitch */}
          <div className='relative'>
            <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
              选择视频源
            </label>
            {isLoadingSources ? (
              <div className='flex items-center justify-center h-12 bg-gray-50/80 rounded-lg border border-gray-200/50 dark:bg-gray-800 dark:border-gray-700'>
                <Loader2 className='h-5 w-5 animate-spin text-gray-400' />
                <span className='ml-2 text-sm text-gray-500 dark:text-gray-400'>
                  加载视频源中...
                </span>
              </div>
            ) : apiSites.length === 0 ? (
              <div className='flex items-center justify-center h-12 bg-gray-50/80 rounded-lg border border-gray-200/50 dark:bg-gray-800 dark:border-gray-700'>
                <span className='text-sm text-gray-500 dark:text-gray-400'>
                  暂无可用源
                </span>
              </div>
            ) : (
              <div className='flex justify-center'>
                <CapsuleSwitch
                  options={apiSites.map((site) => ({
                    label: site.name,
                    value: site.key,
                  }))}
                  active={selectedSource}
                  onChange={(value) => {
                    setSelectedSource(value);
                    handleBackToBrowse();
                  }}
                />
              </div>
            )}
          </div>

          {/* 搜索框 */}
          {selectedSource && (
            <div className='relative'>
              <form onSubmit={handleSearch}>
                <div className='relative'>
                  <input
                    type='text'
                    value={searchInputValue}
                    onChange={(e) => setSearchInputValue(e.target.value)}
                    placeholder='搜索视频...'
                    className='w-full h-12 rounded-lg bg-gray-50/80 py-3 pl-4 pr-12 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:bg-white border border-gray-200/50 shadow-sm dark:bg-gray-800 dark:text-gray-300 dark:focus:bg-gray-700 dark:border-gray-700'
                  />
                  <button
                    type='submit'
                    className='absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-blue-500 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-gray-600 transition-colors'
                  >
                    <Search size={20} />
                  </button>
                </div>
              </form>
            </div>
          )}

          {/* 搜索结果提示和返回按钮 */}
          {viewMode === 'search' && searchKeyword && (
            <div className='flex items-center justify-between bg-blue-50/80 dark:bg-blue-900/20 border border-blue-200/50 dark:border-blue-800/50 rounded-lg px-4 py-3'>
              <span className='text-sm text-gray-700 dark:text-gray-300'>
                搜索结果: <span className='font-medium'>{searchKeyword}</span>
              </span>
              <button
                onClick={handleBackToBrowse}
                className='text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 font-medium'
              >
                返回分类浏览
              </button>
            </div>
          )}

          {/* 分类选择 CapsuleSwitch */}
          {selectedSource && viewMode === 'browse' && (
            <div className='relative'>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-3'>
                选择分类
              </label>
              {isLoadingCategories ? (
                <div className='flex items-center justify-center h-12 bg-gray-50/80 rounded-lg border border-gray-200/50 dark:bg-gray-800 dark:border-gray-700'>
                  <Loader2 className='h-5 w-5 animate-spin text-gray-400' />
                  <span className='ml-2 text-sm text-gray-500 dark:text-gray-400'>
                    加载分类中...
                  </span>
                </div>
              ) : categories.length === 0 ? (
                <div className='flex items-center justify-center h-12 bg-gray-50/80 rounded-lg border border-gray-200/50 dark:bg-gray-800 dark:border-gray-700'>
                  <span className='text-sm text-gray-500 dark:text-gray-400'>
                    暂无分类
                  </span>
                </div>
              ) : (
                <div className='flex justify-center'>
                  <CapsuleSwitch
                    options={categories.map((category) => ({
                      label: category.name,
                      value: category.id,
                    }))}
                    active={selectedCategory}
                    onChange={setSelectedCategory}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* 视频列表 */}
        {selectedSource && (viewMode === 'search' ? searchKeyword : selectedCategory) && (
          <div className='max-w-[95%] mx-auto mt-8'>
            <div className='mb-4'>
              <h2 className='text-xl font-bold text-gray-800 dark:text-gray-200'>
                视频列表
              </h2>
            </div>

            {isLoadingVideos && currentPage === 1 ? (
              <div className='flex justify-center items-center h-40'>
                <div className='animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500'></div>
              </div>
            ) : videos.length === 0 ? (
              <div className='text-center text-gray-500 py-8 dark:text-gray-400'>
                暂无视频
              </div>
            ) : (
              <>
                <div className='grid grid-cols-3 gap-x-2 gap-y-14 sm:gap-y-20 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,_minmax(11rem,_1fr))] sm:gap-x-8'>
                  {videos.map((item) => (
                    <div
                      key={`${item.source}-${item.id}`}
                      className='w-full'
                    >
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
                        type={item.episodes.length > 1 ? 'tv' : 'movie'}
                        isAnime={isAnimeCategoryText(
                          item.type_name,
                          item.class
                        )}
                        typeName={item.type_name || item.class}
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

                {/* Infinite scroll trigger */}
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

export default function SourceSearchPage() {
  return (
    <Suspense>
      <SourceSearchPageClient />
    </Suspense>
  );
}
