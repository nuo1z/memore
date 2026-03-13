import { useEffect, useRef } from "react";
import useWindowScroll from "react-use/lib/useWindowScroll";
import useMediaQuery from "@/hooks/useMediaQuery";
import { cn } from "@/lib/utils";
import NavigationDrawer from "./NavigationDrawer";

interface Props {
  className?: string;
  children?: React.ReactNode;
}

const MobileHeader = (props: Props) => {
  const { className, children } = props;
  const { y: offsetTop } = useWindowScroll();
  const headerRef = useRef<HTMLDivElement>(null);
  const md = useMediaQuery("md");
  const sm = useMediaQuery("sm");

  useEffect(() => {
    const updateHeaderHeight = () => {
      const height = headerRef.current?.getBoundingClientRect().height;
      if (!height || Number.isNaN(height)) {
        return;
      }
      document.documentElement.style.setProperty("--memore-mobile-header-height", `${Math.ceil(height)}px`);
    };

    updateHeaderHeight();
    window.addEventListener("resize", updateHeaderHeight);
    return () => {
      window.removeEventListener("resize", updateHeaderHeight);
    };
  }, []);

  if (md) return null;

  return (
    <>
      <div
        ref={headerRef}
        className={cn(
          "memore-mobile-header sticky top-0 pt-3 pb-2 sm:pt-2 px-4 sm:px-6 sm:mb-1 bg-background bg-opacity-80 backdrop-blur-lg flex flex-row justify-between items-center w-full h-auto flex-nowrap shrink-0 z-20",
          offsetTop > 0 && "shadow-md",
          className,
        )}
      >
        {!sm && <NavigationDrawer />}
        <div className="w-full flex flex-row justify-end items-center">{children}</div>
      </div>
      <div className="memore-mobile-header-placeholder" />
    </>
  );
};

export default MobileHeader;
