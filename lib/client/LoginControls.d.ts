import { type LoginView } from "../public-schema.js";
export declare const loginZh: {
    accounts: string;
    accountUsage: string;
    activeAccount: string;
    localLogin: string;
    localAvailable: string;
    localUnavailable: string;
    useLocal: string;
    webLogin: string;
    webUnavailable: string;
    webExpired: string;
    loginChina: string;
    loginGlobal: string;
    openChina: string;
    openGlobal: string;
    useWeb: string;
    signOut: string;
    signedOut: string;
    signOutFailed: string;
    reopenLogin: string;
    waitingLogin: string;
    loginComplete: string;
    loginFailed: string;
};
type LoginLabel = keyof typeof loginZh;
/** 显示两条登录方式。界面请求仅消费服务端提供的脱敏状态。 */
export declare function LoginControls({ login, refresh, label, }: {
    login: LoginView | undefined;
    refresh: () => Promise<void>;
    label: (key: LoginLabel) => string;
}): import("react").JSX.Element;
export {};
