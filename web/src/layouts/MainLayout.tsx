import { useMemo } from "react";
import { matchPath, Outlet, useLocation } from "react-router-dom";
import type { MemoExplorerContext } from "@/components/MemoExplorer";
import { MemoExplorer, MemoExplorerDrawer } from "@/components/MemoExplorer";
import MobileHeader from "@/components/MobileHeader";
import useCurrentUser from "@/hooks/useCurrentUser";
import { useFilteredMemoStats } from "@/hooks/useFilteredMemoStats";
import useMediaQuery from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import { Routes } from "@/router";

const MainLayout = () => {
  const md = useMediaQuery("md");
  const lg = useMediaQuery("lg");
  const location = useLocation();
  const currentUser = useCurrentUser();

  const context: MemoExplorerContext = useMemo(() => {
    if (location.pathname === Routes.ROOT) return "home";
    if (matchPath("/archived", location.pathname)) return "archived";
    return "home";
  }, [location.pathname]);

  const statsUserName = useMemo(() => {
    if (context === "home") return currentUser?.name;
    return undefined;
  }, [context, currentUser]);

  const { statistics, tags } = useFilteredMemoStats({ userName: statsUserName, context });

  return (
    <section className="@container w-full min-h-full flex flex-col justify-start items-center">
      {!md && (
        <MobileHeader>
          <MemoExplorerDrawer context={context} statisticsData={statistics} tagCount={tags} />
        </MobileHeader>
      )}
      {md && (
        <div className={cn("fixed top-0 left-16 shrink-0 h-svh transition-all memore-android-safe-fixed-top", "border-r border-border", lg ? "w-72" : "w-56")}>
          <MemoExplorer className={cn("px-3 py-6")} context={context} statisticsData={statistics} tagCount={tags} />
        </div>
      )}
      <div className={cn("w-full min-h-full", lg ? "pl-72" : md ? "pl-56" : "")}>
        <div className={cn("w-full mx-auto px-4 sm:px-6 md:pt-6 pb-8")}>
          <Outlet />
        </div>
      </div>
    </section>
  );
};

export default MainLayout;
