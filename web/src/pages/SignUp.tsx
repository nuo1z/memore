import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { LoaderIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";
import { setAccessToken } from "@/auth-state";
import AuthFooter from "@/components/AuthFooter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authServiceClient, userServiceClient } from "@/connect";
import { useAuth } from "@/contexts/AuthContext";
import { useInstance } from "@/contexts/InstanceContext";
import useLoading from "@/hooks/useLoading";
import useNavigateTo from "@/hooks/useNavigateTo";
import { handleError } from "@/lib/error";
import { saveMemoreAutoAuthCredentials } from "@/lib/memore-auto-auth";
import { User_Role, UserSchema } from "@/types/proto/api/v1/user_service_pb";
import { useTranslate } from "@/utils/i18n";

const DEFAULT_LOCAL_USERNAME = "";

const SignUp = () => {
  const t = useTranslate();
  const navigateTo = useNavigateTo();
  const actionBtnLoadingState = useLoading(false);
  const { initialize } = useAuth();
  const [username, setUsername] = useState(DEFAULT_LOCAL_USERNAME);
  const [password, setPassword] = useState("");
  const { generalSetting: instanceGeneralSetting } = useInstance();

  const handleUsernameInputChanged = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUsername(e.target.value);
  };

  const handlePasswordInputChanged = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
  };

  const handleFormSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    handleManualSetup();
  };

  const handleManualSetup = async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername || !password) return;
    if (actionBtnLoadingState.isLoading) return;

    try {
      actionBtnLoadingState.setLoading();
      const user = create(UserSchema, {
        username: trimmedUsername,
        password,
        role: User_Role.ADMIN,
      });
      await userServiceClient.createUser({ user });
      const response = await authServiceClient.signIn({
        credentials: {
          case: "passwordCredentials",
          value: { username: trimmedUsername, password },
        },
      });
      if (response.accessToken) {
        setAccessToken(response.accessToken, response.accessTokenExpiresAt ? timestampDate(response.accessTokenExpiresAt) : undefined);
      }
      saveMemoreAutoAuthCredentials(trimmedUsername, password);
      await initialize();
      navigateTo("/");
    } catch (error: unknown) {
      handleError(error, toast.error, {
        fallbackMessage: "Setup failed",
      });
    }
    actionBtnLoadingState.setFinish();
  };

  return (
    <div className="py-4 sm:py-8 w-80 max-w-full min-h-svh mx-auto flex flex-col justify-start items-center">
      <div className="w-full py-4 grow flex flex-col justify-center items-center">
        <div className="w-full flex flex-row justify-center items-center mb-6">
          <img className="h-14 w-auto rounded-full shadow" src={instanceGeneralSetting.customProfile?.logoUrl || "/logo.webp"} alt="" />
          <p className="memore-auth-brand ml-2 text-5xl text-foreground opacity-80">{instanceGeneralSetting.customProfile?.title || "Memore"}</p>
        </div>
        <>
          <p className="w-full text-lg mt-2 text-muted-foreground">{t("auth.create-your-account") || "Create your local account"}</p>
          <form className="w-full mt-2" onSubmit={handleFormSubmit}>
            <div className="flex flex-col justify-start items-start w-full gap-4">
              <div className="w-full flex flex-col justify-start items-start">
                <span className="leading-8 text-muted-foreground">{t("common.username")}</span>
                <Input
                  className="w-full bg-background h-10"
                  type="text"
                  readOnly={actionBtnLoadingState.isLoading}
                  placeholder="Memorer"
                  value={username}
                  autoComplete="username"
                  onChange={handleUsernameInputChanged}
                  required
                />
              </div>
              <div className="w-full flex flex-col justify-start items-start">
                <span className="leading-8 text-muted-foreground">{t("common.password")}</span>
                <Input
                  className="w-full bg-background h-10"
                  type="password"
                  readOnly={actionBtnLoadingState.isLoading}
                  placeholder={t("common.password")}
                  value={password}
                  autoComplete="new-password"
                  onChange={handlePasswordInputChanged}
                  required
                />
              </div>
            </div>
            <div className="flex flex-row justify-end items-center w-full mt-6">
              <Button type="submit" className="w-full h-10" disabled={actionBtnLoadingState.isLoading}>
                {actionBtnLoadingState.isLoading ? (
                  <span className="inline-flex items-center">
                    {t("common.confirm") || "Start"}
                    <LoaderIcon className="w-4 h-4 animate-spin ml-2 opacity-70" />
                  </span>
                ) : (
                  <>{t("common.confirm") || "Start"}</>
                )}
              </Button>
            </div>
          </form>
        </>
      </div>
      <AuthFooter />
    </div>
  );
};

export default SignUp;
