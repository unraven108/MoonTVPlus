/* eslint-disable no-console,react-hooks/exhaustive-deps,@typescript-eslint/no-explicit-any */

'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { GetBangumiCalendarData } from '@/lib/bangumi.client';
import {
  getDoubanCategories,
  getDoubanList,
  getDoubanRecommends,
} from '@/lib/douban.client';
import { DoubanItem, DoubanResult } from '@/lib/types';
import { usePersistedState } from '@/lib/use-persisted-state';
import { useListScrollRestoration } from '@/hooks/useListScrollRestoration';

import BangumiScheduleTimeline from '@/components/BangumiScheduleTimeline';
import DoubanCardSkeleton from '@/components/DoubanCardSkeleton';
import DoubanCustomSelector from '@/components/DoubanCustomSelector';
import DoubanSelector from '@/components/DoubanSelector';
import { triggerGlobalError } from '@/components/GlobalErrorIndicator';
import PageLayout from '@/components/PageLayout';
import VideoCard from '@/components/VideoCard';

// ---- 列表数据缓存（sessionStorage），用于从播放/详情页返回时恢复已加载的多页数据 ----
// douban 列表是无限滚动分页加载，用户滚到深处时已加载多页数据（页面很高）。
// 返回时组件重新挂载只加载第一页，页面高度远小于离开时，滚动位置无法恢复。
// 因此在跳转前把已加载的数据/页码缓存起来，返回后直接恢复，页面立即有完整高度。
interface DoubanListCache {
  doubanData: DoubanItem[];
  currentPage: number;
  hasMore: boolean;
}

const LIST_CACHE_PREFIX = 'douban-list-cache:';

function readListCache(key: string): DoubanListCache | null {
  try {
    const raw = sessionStorage.getItem(`${LIST_CACHE_PREFIX}${key}`);
    return raw ? (JSON.parse(raw) as DoubanListCache) : null;
  } catch {
    return null;
  }
}

function writeListCache(key: string, data: DoubanListCache) {
  try {
    sessionStorage.setItem(`${LIST_CACHE_PREFIX}${key}`, JSON.stringify(data));
  } catch {
    // sessionStorage 不可用时静默忽略
  }
}

function DoubanPageClient() {
  const searchParams = useSearchParams();
  const [doubanData, setDoubanData] = useState<DoubanItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectorsReady, setSelectorsReady] = useState(false);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const loadingRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // 已尝试恢复列表缓存的 key（避免重复恢复）
  const restoredListCacheKeyRef = useRef<string | null>(null);
  // 从缓存恢复的页码（跳过 fetchMore 的重复请求）
  const restoredPageRef = useRef<number | null>(null);

  // 用于存储最新参数值的 refs
  const currentParamsRef = useRef({
    type: '',
    primarySelection: '',
    secondarySelection: '',
    multiLevelSelection: {} as Record<string, string>,
    selectedWeekday: '',
    currentPage: 0,
  });

  // 列表滚动位置保存/恢复：从播放/详情页返回时恢复到之前浏览的位置
  const { saveScroll: saveDoubanScroll } = useListScrollRestoration({
    prefix: 'douban',
    getFilterKey: () =>
      `${currentParamsRef.current.type}:${currentParamsRef.current.primarySelection}:${currentParamsRef.current.secondarySelection}:${JSON.stringify(
        currentParamsRef.current.multiLevelSelection
      )}:${currentParamsRef.current.selectedWeekday}`,
    ready: selectorsReady && !loading && doubanData.length > 0,
  });

  // 列表缓存 key（与滚动位置 key 一致，按筛选条件区分）
  const getListCacheKey = () =>
    `${currentParamsRef.current.type}:${currentParamsRef.current.primarySelection}:${currentParamsRef.current.secondarySelection}:${JSON.stringify(
      currentParamsRef.current.multiLevelSelection
    )}:${currentParamsRef.current.selectedWeekday}`;

  // 跳转播放/详情页前：缓存已加载的列表数据 + 保存滚动位置
  const saveListState = () => {
    if (doubanData.length > 0) {
      writeListCache(getListCacheKey(), {
        doubanData,
        currentPage,
        hasMore,
      });
    }
    saveDoubanScroll();
  };

  const type = searchParams.get('type') || 'movie';

  // 获取 runtimeConfig 中的自定义分类数据
  const [customCategories, setCustomCategories] = useState<
    Array<{ name: string; type: 'movie' | 'tv'; query: string }>
  >([]);

  // 选择器状态 - 完全独立，不依赖URL参数；持久化到 sessionStorage（按 type 区分），
  // 从详情/播放页返回时恢复上次筛选
  const [primarySelection, setPrimarySelection] = usePersistedState<string>(
    'primarySelection',
    () => {
      if (type === 'movie') return '热门';
      if (type === 'tv' || type === 'show') return '最近热门';
      if (type === 'anime') return '每日放送';
      return '';
    },
    { key: `douban:${type}:primary` }
  );
  const [secondarySelection, setSecondarySelection] = usePersistedState<string>(
    'secondarySelection',
    () => {
      if (type === 'movie') return '全部';
      if (type === 'tv') return 'tv';
      if (type === 'show') return 'show';
      return '全部';
    },
    { key: `douban:${type}:secondary` }
  );

  // MultiLevelSelector 状态
  const [multiLevelValues, setMultiLevelValues] = usePersistedState<
    Record<string, string>
  >(
    'multiLevelValues',
    {
      type: 'all',
      region: 'all',
      year: 'all',
      platform: 'all',
      label: 'all',
      sort: 'T',
    },
    { key: `douban:${type}:multi` }
  );

  // 星期选择器状态 - 默认选中今天
  const getTodayWeekday = (): string => {
    const today = new Date().getDay();
    // getDay() 返回 0-6，0 是周日，1-6 是周一到周六
    const weekdayMap = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return weekdayMap[today];
  };

  const [selectedWeekday, setSelectedWeekday] = usePersistedState<string>(
    'selectedWeekday',
    () => {
      if (type === 'anime') {
        return getTodayWeekday();
      }
      return '';
    },
    { key: `douban:${type}:weekday` }
  );

  // 每日放送视图模式：grid(卡片) / schedule(时刻表)
  const [viewMode, setViewMode] = usePersistedState<'grid' | 'schedule'>(
    'viewMode',
    'grid',
    { key: `douban:${type}:view` }
  );

  // 获取自定义分类数据
  useEffect(() => {
    const runtimeConfig = (window as any).RUNTIME_CONFIG;
    if (runtimeConfig?.CUSTOM_CATEGORIES?.length > 0) {
      setCustomCategories(runtimeConfig.CUSTOM_CATEGORIES);
    }
  }, []);

  // 同步最新参数值到 ref
  useEffect(() => {
    currentParamsRef.current = {
      type,
      primarySelection,
      secondarySelection,
      multiLevelSelection: multiLevelValues,
      selectedWeekday,
      currentPage,
    };
  }, [
    type,
    primarySelection,
    secondarySelection,
    multiLevelValues,
    selectedWeekday,
    currentPage,
  ]);

  // 初始化时标记选择器为准备好状态
  useEffect(() => {
    // 短暂延迟确保初始状态设置完成
    const timer = setTimeout(() => {
      setSelectorsReady(true);
    }, 50);

    return () => clearTimeout(timer);
  }, []); // 只在组件挂载时执行一次

  // type变化时立即重置selectorsReady（最高优先级）
  useEffect(() => {
    setSelectorsReady(false);
    setLoading(true); // 立即显示loading状态
  }, [type]);

  // 当 type 变化时重置选择器状态（首次挂载保留 usePersistedState 恢复的值）
  const prevTypeRef = useRef(type);
  useEffect(() => {
    const typeChanged = prevTypeRef.current !== type;
    prevTypeRef.current = type;

    // 首次挂载：不重置，保留从 sessionStorage 恢复的筛选；仅标记选择器就绪
    if (!typeChanged) {
      const timer = setTimeout(() => {
        setSelectorsReady(true);
      }, 50);
      return () => clearTimeout(timer);
    }

    // type 变化：重置为默认
    if (type === 'custom' && customCategories.length > 0) {
      // 自定义分类模式：优先选择 movie，如果没有 movie 则选择 tv
      const types = Array.from(
        new Set(customCategories.map((cat) => cat.type))
      );
      if (types.length > 0) {
        // 优先选择 movie，如果没有 movie 则选择 tv
        let selectedType = types[0]; // 默认选择第一个
        if (types.includes('movie')) {
          selectedType = 'movie';
        } else {
          selectedType = 'tv';
        }
        setPrimarySelection(selectedType);

        // 设置选中类型的第一个分类的 query 作为二级选择
        const firstCategory = customCategories.find(
          (cat) => cat.type === selectedType
        );
        if (firstCategory) {
          setSecondarySelection(firstCategory.query);
        }
      }
      setSelectedWeekday(''); // 清空星期选择
    } else {
      // 原有逻辑
      if (type === 'movie') {
        setPrimarySelection('热门');
        setSecondarySelection('全部');
        setSelectedWeekday(''); // 清空星期选择
      } else if (type === 'tv') {
        setPrimarySelection('最近热门');
        setSecondarySelection('tv');
        setSelectedWeekday(''); // 清空星期选择
      } else if (type === 'show') {
        setPrimarySelection('最近热门');
        setSecondarySelection('show');
        setSelectedWeekday(''); // 清空星期选择
      } else if (type === 'anime') {
        setPrimarySelection('每日放送');
        setSecondarySelection('全部');
        setSelectedWeekday(getTodayWeekday()); // 默认选中今天
      } else {
        setPrimarySelection('');
        setSecondarySelection('全部');
        setSelectedWeekday(''); // 清空星期选择
      }
    }

    // 清空 MultiLevelSelector 状态
    setMultiLevelValues({
      type: 'all',
      region: 'all',
      year: 'all',
      platform: 'all',
      label: 'all',
      sort: 'T',
    });

    // 使用短暂延迟确保状态更新完成后标记选择器准备好
    const timer = setTimeout(() => {
      setSelectorsReady(true);
    }, 50);

    return () => clearTimeout(timer);
  }, [type, customCategories]);

  // custom 模式：分类加载完成后，若选择器为空（无恢复值）则设置默认
  useEffect(() => {
    if (type !== 'custom' || customCategories.length === 0) return;
    if (currentParamsRef.current.primarySelection) return;
    const types = Array.from(
      new Set(customCategories.map((cat) => cat.type))
    );
    if (types.length === 0) return;
    const selectedType = types.includes('movie') ? 'movie' : types[0];
    setPrimarySelection(selectedType);
    const firstCategory = customCategories.find(
      (cat) => cat.type === selectedType
    );
    if (firstCategory) {
      setSecondarySelection(firstCategory.query);
    }
  }, [type, customCategories]);

  // 生成骨架屏数据
  const skeletonData = Array.from({ length: 25 }, (_, index) => index);

  // 参数快照比较函数
  const isSnapshotEqual = useCallback(
    (
      snapshot1: {
        type: string;
        primarySelection: string;
        secondarySelection: string;
        multiLevelSelection: Record<string, string>;
        selectedWeekday: string;
        currentPage: number;
      },
      snapshot2: {
        type: string;
        primarySelection: string;
        secondarySelection: string;
        multiLevelSelection: Record<string, string>;
        selectedWeekday: string;
        currentPage: number;
      }
    ) => {
      return (
        snapshot1.type === snapshot2.type &&
        snapshot1.primarySelection === snapshot2.primarySelection &&
        snapshot1.secondarySelection === snapshot2.secondarySelection &&
        snapshot1.selectedWeekday === snapshot2.selectedWeekday &&
        snapshot1.currentPage === snapshot2.currentPage &&
        JSON.stringify(snapshot1.multiLevelSelection) ===
          JSON.stringify(snapshot2.multiLevelSelection)
      );
    },
    []
  );

  // 生成API请求参数的辅助函数
  const getRequestParams = useCallback(
    (pageStart: number) => {
      // 当type为tv或show时，kind统一为'tv'，category使用type本身
      if (type === 'tv' || type === 'show') {
        return {
          kind: 'tv' as const,
          category: type,
          type: secondarySelection,
          pageLimit: 25,
          pageStart,
        };
      }

      // 电影类型保持原逻辑
      return {
        kind: type as 'tv' | 'movie',
        category: primarySelection,
        type: secondarySelection,
        pageLimit: 25,
        pageStart,
      };
    },
    [type, primarySelection, secondarySelection]
  );

  // 防抖的数据加载函数
  const loadInitialData = useCallback(async () => {
    // 创建当前参数的快照
    const requestSnapshot = {
      type,
      primarySelection,
      secondarySelection,
      multiLevelSelection: multiLevelValues,
      selectedWeekday,
      currentPage: 0,
    };

    try {
      setLoading(true);
      // 确保在加载初始数据时重置页面状态
      setDoubanData([]);
      setCurrentPage(0);
      setHasMore(true);
      setIsLoadingMore(false);

      let data: DoubanResult;

      if (type === 'custom') {
        // 自定义分类模式：根据选中的一级和二级选项获取对应的分类
        const selectedCategory = customCategories.find(
          (cat) =>
            cat.type === primarySelection && cat.query === secondarySelection
        );

        if (selectedCategory) {
          data = await getDoubanList({
            tag: selectedCategory.query,
            type: selectedCategory.type,
            pageLimit: 25,
            pageStart: 0,
          });
        } else {
          throw new Error('没有找到对应的分类');
        }
      } else if (type === 'anime' && primarySelection === '每日放送') {
        const calendarData = await GetBangumiCalendarData();
        // 优先使用选中的星期；若选中的星期无效/已过期（如持久化的旧日期），
        // 依次降级为今天、第一个有内容的星期，避免整个页面空白
        const weekdayData =
          calendarData.find(
            (item) => item.weekday.en === selectedWeekday
          ) ||
          calendarData.find(
            (item) => item.weekday.en === getTodayWeekday()
          ) ||
          calendarData.find(
            (item) => item.items && item.items.length > 0
          );
        if (weekdayData) {
          data = {
            code: 200,
            message: 'success',
            list: weekdayData.items
              .filter((item) => item.images) // 过滤掉没有图片的
              .map((item) => ({
                id: item.id?.toString() || '',
                title: item.name_cn || item.name,
                poster:
                  item.images.large ||
                  item.images.common ||
                  item.images.medium ||
                  item.images.small ||
                  item.images.grid,
                rate: item.rating?.score?.toFixed(1) || '',
                year: item.air_date?.split('-')?.[0] || '',
              })),
          };
        } else {
          throw new Error('没有找到对应的日期');
        }
      } else if (type === 'anime') {
        data = await getDoubanRecommends({
          kind: primarySelection === '番剧' ? 'tv' : 'movie',
          pageLimit: 25,
          pageStart: 0,
          category: '动画',
          format: primarySelection === '番剧' ? '电视剧' : '',
          region: multiLevelValues.region
            ? (multiLevelValues.region as string)
            : '',
          year: multiLevelValues.year ? (multiLevelValues.year as string) : '',
          platform: multiLevelValues.platform
            ? (multiLevelValues.platform as string)
            : '',
          sort: multiLevelValues.sort ? (multiLevelValues.sort as string) : '',
          label: multiLevelValues.label
            ? (multiLevelValues.label as string)
            : '',
        });
      } else if (primarySelection === '全部') {
        data = await getDoubanRecommends({
          kind: type === 'show' ? 'tv' : (type as 'tv' | 'movie'),
          pageLimit: 25,
          pageStart: 0, // 初始数据加载始终从第一页开始
          category: multiLevelValues.type
            ? (multiLevelValues.type as string)
            : '',
          format: type === 'show' ? '综艺' : type === 'tv' ? '电视剧' : '',
          region: multiLevelValues.region
            ? (multiLevelValues.region as string)
            : '',
          year: multiLevelValues.year ? (multiLevelValues.year as string) : '',
          platform: multiLevelValues.platform
            ? (multiLevelValues.platform as string)
            : '',
          sort: multiLevelValues.sort ? (multiLevelValues.sort as string) : '',
          label: multiLevelValues.label
            ? (multiLevelValues.label as string)
            : '',
        });
      } else {
        data = await getDoubanCategories(getRequestParams(0));
      }

      if (data.code === 200) {
        // 检查参数是否仍然一致，如果一致才设置数据
        // 使用 ref 获取最新的当前值
        const currentSnapshot = { ...currentParamsRef.current };

        if (isSnapshotEqual(requestSnapshot, currentSnapshot)) {
          setDoubanData(data.list);
          setHasMore(data.list.length !== 0);
          setLoading(false);
        } else {
          console.log('参数不一致，不执行任何操作，避免设置过期数据');
          // 关键：即使参数不一致也必须结束 loading，
          // 否则切换分类/快速操作后页面会一直显示骨架屏（"一直转圈"）
          setLoading(false);
        }
        // 如果参数不一致，不执行任何操作，避免设置过期数据
      } else {
        throw new Error(data.message || '获取数据失败');
      }
    } catch (err) {
      console.error(err);
      setLoading(false); // 发生错误时总是停止loading状态
      // 动漫「每日放送」依赖 Bangumi 外部数据源，失败时给出明确提示，
      // 避免用户只看到空白页而不知道原因
      if (type === 'anime' && primarySelection === '每日放送') {
        triggerGlobalError(
          '动漫数据加载失败，请检查网络或「设置-动漫数据源」，稍后重试'
        );
      }
    }
  }, [
    type,
    primarySelection,
    secondarySelection,
    multiLevelValues,
    selectedWeekday,
    getRequestParams,
    customCategories,
  ]);

  // 只在选择器准备好后才加载数据
  useEffect(() => {
    // 只有在选择器准备好时才开始加载
    if (!selectorsReady) {
      return;
    }

    // 尝试从缓存恢复已加载的多页列表数据（从播放/详情页返回场景）：
    // 恢复后跳过初始请求，页面立即有完整高度，配合滚动位置恢复
    const cacheKey = getListCacheKey();
    if (doubanData.length === 0 && restoredListCacheKeyRef.current !== cacheKey) {
      restoredListCacheKeyRef.current = cacheKey;
      const cached = readListCache(cacheKey);
      if (cached && cached.doubanData.length > 0) {
        setDoubanData(cached.doubanData);
        setHasMore(cached.hasMore);
        // 关键：恢复正常 loading 状态，否则页面一直显示骨架屏（type effect 设过 setLoading(true)）
        setLoading(false);
        if (cached.currentPage > 0) {
          // 恢复页码，fetchMore effect 会用 restoredPageRef 跳过重复请求
          restoredPageRef.current = cached.currentPage;
          setCurrentPage(cached.currentPage);
        }
        return; // 跳过 loadInitialData
      }
    }

    // 清除之前的防抖定时器
    if (debounceTimeoutRef.current) {
      clearTimeout(debounceTimeoutRef.current);
    }

    // 使用防抖机制加载数据，避免连续状态更新触发多次请求
    debounceTimeoutRef.current = setTimeout(() => {
      loadInitialData();
    }, 100); // 100ms 防抖延迟

    // 清理函数
    return () => {
      if (debounceTimeoutRef.current) {
        clearTimeout(debounceTimeoutRef.current);
      }
    };
  }, [
    selectorsReady,
    type,
    primarySelection,
    secondarySelection,
    multiLevelValues,
    selectedWeekday,
    loadInitialData,
  ]);

  // 单独处理 currentPage 变化（加载更多）
  useEffect(() => {
    if (currentPage > 0) {
      // 从缓存恢复的页码：数据已包含，跳过 fetchMore 的重复请求
      if (
        restoredPageRef.current !== null &&
        restoredPageRef.current === currentPage &&
        doubanData.length > 0
      ) {
        restoredPageRef.current = null;
        return;
      }

      const fetchMoreData = async () => {
        // 创建当前参数的快照
        const requestSnapshot = {
          type,
          primarySelection,
          secondarySelection,
          multiLevelSelection: multiLevelValues,
          selectedWeekday,
          currentPage,
        };

        try {
          setIsLoadingMore(true);

          let data: DoubanResult;
          if (type === 'custom') {
            // 自定义分类模式：根据选中的一级和二级选项获取对应的分类
            const selectedCategory = customCategories.find(
              (cat) =>
                cat.type === primarySelection &&
                cat.query === secondarySelection
            );

            if (selectedCategory) {
              data = await getDoubanList({
                tag: selectedCategory.query,
                type: selectedCategory.type,
                pageLimit: 25,
                pageStart: currentPage * 25,
              });
            } else {
              throw new Error('没有找到对应的分类');
            }
          } else if (type === 'anime' && primarySelection === '每日放送') {
            // 每日放送模式下，不进行数据请求，返回空数据
            data = {
              code: 200,
              message: 'success',
              list: [],
            };
          } else if (type === 'anime') {
            data = await getDoubanRecommends({
              kind: primarySelection === '番剧' ? 'tv' : 'movie',
              pageLimit: 25,
              pageStart: currentPage * 25,
              category: '动画',
              format: primarySelection === '番剧' ? '电视剧' : '',
              region: multiLevelValues.region
                ? (multiLevelValues.region as string)
                : '',
              year: multiLevelValues.year
                ? (multiLevelValues.year as string)
                : '',
              platform: multiLevelValues.platform
                ? (multiLevelValues.platform as string)
                : '',
              sort: multiLevelValues.sort
                ? (multiLevelValues.sort as string)
                : '',
              label: multiLevelValues.label
                ? (multiLevelValues.label as string)
                : '',
            });
          } else if (primarySelection === '全部') {
            data = await getDoubanRecommends({
              kind: type === 'show' ? 'tv' : (type as 'tv' | 'movie'),
              pageLimit: 25,
              pageStart: currentPage * 25,
              category: multiLevelValues.type
                ? (multiLevelValues.type as string)
                : '',
              format: type === 'show' ? '综艺' : type === 'tv' ? '电视剧' : '',
              region: multiLevelValues.region
                ? (multiLevelValues.region as string)
                : '',
              year: multiLevelValues.year
                ? (multiLevelValues.year as string)
                : '',
              platform: multiLevelValues.platform
                ? (multiLevelValues.platform as string)
                : '',
              sort: multiLevelValues.sort
                ? (multiLevelValues.sort as string)
                : '',
              label: multiLevelValues.label
                ? (multiLevelValues.label as string)
                : '',
            });
          } else {
            data = await getDoubanCategories(
              getRequestParams(currentPage * 25)
            );
          }

          if (data.code === 200) {
            // 检查参数是否仍然一致，如果一致才设置数据
            // 使用 ref 获取最新的当前值
            const currentSnapshot = { ...currentParamsRef.current };

            if (isSnapshotEqual(requestSnapshot, currentSnapshot)) {
              setDoubanData((prev) => [...prev, ...data.list]);
              setHasMore(data.list.length !== 0);
            } else {
              console.log('参数不一致，不执行任何操作，避免设置过期数据');
            }
          } else {
            throw new Error(data.message || '获取数据失败');
          }
        } catch (err) {
          console.error(err);
        } finally {
          setIsLoadingMore(false);
        }
      };

      fetchMoreData();
    }
  }, [
    currentPage,
    type,
    primarySelection,
    secondarySelection,
    customCategories,
    multiLevelValues,
    selectedWeekday,
  ]);

  // 设置滚动监听
  useEffect(() => {
    // 如果没有更多数据或正在加载，则不设置监听
    if (!hasMore || isLoadingMore || loading) {
      return;
    }

    // 确保 loadingRef 存在
    if (!loadingRef.current) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setCurrentPage((prev) => prev + 1);
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(loadingRef.current);
    observerRef.current = observer;

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [hasMore, isLoadingMore, loading]);

  // 首屏如果未被撑满，仅在第一页时额外请求一次下一页
  useEffect(() => {
    if (
      loading ||
      !selectorsReady ||
      isLoadingMore ||
      !hasMore ||
      doubanData.length === 0 ||
      currentPage !== 0
    ) {
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      const contentEl = contentRef.current;
      if (!contentEl) return;

      const rect = contentEl.getBoundingClientRect();
      const preloadThreshold = window.innerHeight + 120;

      if (rect.bottom < preloadThreshold) {
        setCurrentPage(1);
      }
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [loading, selectorsReady, isLoadingMore, hasMore, doubanData.length, currentPage]);

  // 处理选择器变化
  const handlePrimaryChange = useCallback(
    (value: string) => {
      // 只有当值真正改变时才设置loading状态
      if (value !== primarySelection) {
        setLoading(true);
        // 立即重置页面状态，防止基于旧状态的请求
        setCurrentPage(0);
        setDoubanData([]);
        setHasMore(true);
        setIsLoadingMore(false);

        // 清空 MultiLevelSelector 状态
        setMultiLevelValues({
          type: 'all',
          region: 'all',
          year: 'all',
          platform: 'all',
          label: 'all',
          sort: 'T',
        });

        // 如果是自定义分类模式，同时更新一级和二级选择器
        if (type === 'custom' && customCategories.length > 0) {
          const firstCategory = customCategories.find(
            (cat) => cat.type === value
          );
          if (firstCategory) {
            // 批量更新状态，避免多次触发数据加载
            setPrimarySelection(value);
            setSecondarySelection(firstCategory.query);
          } else {
            setPrimarySelection(value);
          }
        } else {
          // 电视剧和综艺切换到"最近热门"时，重置二级分类为第一个选项
          if ((type === 'tv' || type === 'show') && value === '最近热门') {
            setPrimarySelection(value);
            if (type === 'tv') {
              setSecondarySelection('tv');
            } else if (type === 'show') {
              setSecondarySelection('show');
            }
          } else {
            setPrimarySelection(value);
          }

          // 动漫类型：切换到"每日放送"时设置当天，切换到其他分类时清空星期选择
          if (type === 'anime') {
            if (value === '每日放送') {
              setSelectedWeekday(getTodayWeekday());
            } else {
              setSelectedWeekday('');
            }
          }
        }
      }
    },
    [primarySelection, type, customCategories]
  );

  const handleSecondaryChange = useCallback(
    (value: string) => {
      // 只有当值真正改变时才设置loading状态
      if (value !== secondarySelection) {
        setLoading(true);
        // 立即重置页面状态，防止基于旧状态的请求
        setCurrentPage(0);
        setDoubanData([]);
        setHasMore(true);
        setIsLoadingMore(false);
        setSecondarySelection(value);
      }
    },
    [secondarySelection]
  );

  const handleMultiLevelChange = useCallback(
    (values: Record<string, string>) => {
      // 比较两个对象是否相同，忽略顺序
      const isEqual = (
        obj1: Record<string, string>,
        obj2: Record<string, string>
      ) => {
        const keys1 = Object.keys(obj1).sort();
        const keys2 = Object.keys(obj2).sort();

        if (keys1.length !== keys2.length) return false;

        return keys1.every((key) => obj1[key] === obj2[key]);
      };

      // 如果相同，则不设置loading状态
      if (isEqual(values, multiLevelValues)) {
        return;
      }

      setLoading(true);
      // 立即重置页面状态，防止基于旧状态的请求
      setCurrentPage(0);
      setDoubanData([]);
      setHasMore(true);
      setIsLoadingMore(false);
      setMultiLevelValues(values);
    },
    [multiLevelValues]
  );

  const handleWeekdayChange = useCallback((weekday: string) => {
    setSelectedWeekday(weekday);
  }, []);

  const getPageTitle = () => {
    // 根据 type 生成标题
    return type === 'movie'
      ? '电影'
      : type === 'tv'
      ? '电视剧'
      : type === 'anime'
      ? '动漫'
      : type === 'show'
      ? '综艺'
      : '自定义';
  };

  const getPageDescription = () => {
    if (type === 'anime' && primarySelection === '每日放送') {
      return '来自 Bangumi 番组计划的精选内容';
    }
    return '来自豆瓣的精选内容';
  };

  const getActivePath = () => {
    const params = new URLSearchParams();
    if (type) params.set('type', type);

    const queryString = params.toString();
    const activePath = `/douban${queryString ? `?${queryString}` : ''}`;
    return activePath;
  };

  // 是否为时刻表视图（每日放送 + 已切换）
  const isScheduleView =
    type === 'anime' &&
    primarySelection === '每日放送' &&
    viewMode === 'schedule';

  return (
    <PageLayout activePath={getActivePath()}>
      <div className='px-4 sm:px-10 py-4 sm:py-8 overflow-visible'>
        {/* 页面标题和选择器 */}
        <div className='mb-6 sm:mb-8 space-y-4 sm:space-y-6'>
          {/* 页面标题 */}
          <div>
            <h1 className='text-2xl sm:text-3xl font-bold text-gray-800 mb-1 sm:mb-2 dark:text-gray-200'>
              {getPageTitle()}
            </h1>
            <p className='text-sm sm:text-base text-gray-600 dark:text-gray-400'>
              {getPageDescription()}
            </p>
          </div>

          {/* 选择器组件 */}
          {type !== 'custom' ? (
            <div className='bg-white/60 dark:bg-gray-800/40 rounded-2xl p-4 sm:p-6 border border-gray-200/30 dark:border-gray-700/30 backdrop-blur-sm'>
              <DoubanSelector
                type={type as 'movie' | 'tv' | 'show' | 'anime'}
                primarySelection={primarySelection}
                secondarySelection={secondarySelection}
                onPrimaryChange={handlePrimaryChange}
                onSecondaryChange={handleSecondaryChange}
                onMultiLevelChange={handleMultiLevelChange}
                onWeekdayChange={handleWeekdayChange}
                viewMode={viewMode}
                onViewModeChange={setViewMode}
              />
            </div>
          ) : (
            <div className='bg-white/60 dark:bg-gray-800/40 rounded-2xl p-4 sm:p-6 border border-gray-200/30 dark:border-gray-700/30 backdrop-blur-sm'>
              <DoubanCustomSelector
                customCategories={customCategories}
                primarySelection={primarySelection}
                secondarySelection={secondarySelection}
                onPrimaryChange={handlePrimaryChange}
                onSecondaryChange={handleSecondaryChange}
              />
            </div>
          )}
        </div>

        {/* 内容展示区域 */}
        <div ref={contentRef} className='max-w-[95%] mx-auto mt-8 overflow-visible'>
          {/* 时刻表视图（每日放送） */}
          {isScheduleView ? (
            <BangumiScheduleTimeline weekday={selectedWeekday} />
          ) : (
            /* 内容网格 */
            <div className='justify-start grid grid-cols-3 gap-x-2 gap-y-12 px-0 sm:px-2 sm:grid-cols-[repeat(auto-fill,minmax(160px,1fr))] sm:gap-x-8 sm:gap-y-20'>
              {loading || !selectorsReady
                ? // 显示骨架屏
                  skeletonData.map((index) => (
                    <DoubanCardSkeleton key={index} />
                  ))
                : // 显示实际数据
                  doubanData.map((item, index) => (
                    <div key={`${item.title}-${index}`} className='w-full'>
                      <VideoCard
                        from='douban'
                        title={item.title}
                        poster={item.poster}
                        douban_id={Number(item.id)}
                        rate={item.rate}
                        year={item.year}
                        type={type === 'movie' ? 'movie' : ''} // 电影类型严格控制，tv 不控
                        isBangumi={
                          type === 'anime' && primarySelection === '每日放送'
                        }
                        isAnime={type === 'anime'}
                        onBeforeNavigate={saveListState}
                      />
                    </div>
                  ))}
            </div>
          )}

          {/* 加载更多指示器 */}
          {!isScheduleView && hasMore && !loading && (
            <div
              ref={(el) => {
                if (el && el.offsetParent !== null) {
                  (
                    loadingRef as React.MutableRefObject<HTMLDivElement | null>
                  ).current = el;
                }
              }}
              className='flex justify-center mt-12 py-8'
            >
              {isLoadingMore && (
                <div className='flex items-center gap-2'>
                  <div className='animate-spin rounded-full h-6 w-6 border-b-2 border-green-500'></div>
                  <span className='text-gray-600'>加载中...</span>
                </div>
              )}
            </div>
          )}

          {/* 没有更多数据提示 */}
          {!isScheduleView && !hasMore && doubanData.length > 0 && (
            <div className='text-center text-gray-500 py-8'>已加载全部内容</div>
          )}

          {/* 空状态 */}
          {!isScheduleView && !loading && doubanData.length === 0 && (
            <div className='text-center text-gray-500 py-8'>暂无相关内容</div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function DoubanPage() {
  return (
    <Suspense>
      <DoubanPageClient />
    </Suspense>
  );
}
