import { useEffect } from "react";
import { Link } from "react-router-dom";
import AuthFooter from "@/components/AuthFooter";
import PasswordSignInForm from "@/components/PasswordSignInForm";
import { useInstance } from "@/contexts/InstanceContext";
import useCurrentUser from "@/hooks/useCurrentUser";
import { Routes } from "@/router";
import { useTranslate } from "@/utils/i18n";

const SignIn = () => {
  const t = useTranslate();
  const currentUser = useCurrentUser();
  const { generalSetting: instanceGeneralSetting } = useInstance();

  useEffect(() => {
    if (currentUser?.name) {
      window.location.href = Routes.ROOT;
    }
  }, [currentUser]);

  return (
    <div className="py-4 sm:py-8 w-80 max-w-full min-h-svh mx-auto flex flex-col justify-start items-center">
      <div className="w-full py-4 grow flex flex-col justify-center items-center">
        <div className="w-full flex flex-row justify-center items-center mb-6">
          <img className="h-14 w-auto rounded-full shadow" src={instanceGeneralSetting.customProfile?.logoUrl || "/logo.webp"} alt="" />
          <p className="memore-auth-brand ml-2 text-5xl text-foreground opacity-80">{instanceGeneralSetting.customProfile?.title || "Memore"}</p>
        </div>
        <PasswordSignInForm />
        {!instanceGeneralSetting.disallowUserRegistration && (
          <p className="w-full mt-4 text-sm">
            <span className="text-muted-foreground">{t("auth.sign-up-tip")}</span>
            <Link to="/auth/signup" className="cursor-pointer ml-2 text-primary hover:underline" viewTransition>
              {t("common.sign-up")}
            </Link>
          </p>
        )}
      </div>
      <AuthFooter />
    </div>
  );
};

export default SignIn;
