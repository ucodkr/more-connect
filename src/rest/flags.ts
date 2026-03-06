declare const __MORE_REST_NO_OAUTH__: boolean | undefined;
declare const __MORE_REST_WEB__: boolean | undefined;
declare const __MORE_REST_BUILD_HASH__: string | undefined;
declare const __MORE_REST_BUILD_TAG__: string | undefined;

export const NO_OAUTH = typeof __MORE_REST_NO_OAUTH__ !== "undefined" && __MORE_REST_NO_OAUTH__;
export const IS_WEB = typeof __MORE_REST_WEB__ !== "undefined" && __MORE_REST_WEB__;
export const BUILD_HASH = typeof __MORE_REST_BUILD_HASH__ !== "undefined" ? __MORE_REST_BUILD_HASH__ : "dev";
export const BUILD_TAG = typeof __MORE_REST_BUILD_TAG__ !== "undefined" ? __MORE_REST_BUILD_TAG__ : "";
export const BUILD_LABEL = BUILD_TAG || BUILD_HASH;
