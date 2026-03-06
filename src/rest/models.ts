export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type KeyValue = { id?: string; key: string; value: string; enabled: boolean };
export type EnvVar = { id?: string; key: string; value: string; enabled: boolean };
export type MultipartField = {
  id?: string;
  key: string;
  value?: string;
  enabled: boolean;
  isFile?: boolean;
  fileName?: string;
  fileData?: string;
  contentType?: string;
};

export type Body =
  | { type: "none" }
  | { type: "json"; json: string }
  | { type: "raw"; raw: string; contentType: string }
  | { type: "x-www-form-urlencoded"; fields: KeyValue[] }
  | { type: "multipart"; fields: MultipartField[] };

export type Auth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apiKey"; in: "header" | "query"; name: string; value: string }
  | { type: "oauth2"; configId: string }; // token stored in secrets

export type OAuth2Config = {
  id: string;
  name: string;
  flow: "authorization_code_pkce" | "client_credentials";
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope: string; // space-delimited
  audience?: string;
  // client secret is stored in secrets (optional, usually not for PKCE)
};

export type RequestItem = {
  id: string;
  type: "request";
  name: string;
  method: HttpMethod;
  url: string;
  params: KeyValue[];
  headers: KeyValue[];
  body: Body;
  auth: Auth;
  oauth2?: OAuth2Config; // convenience editable config; tokens not here
  createdAt: number;
  updatedAt: number;
};

export type FolderItem = {
  id: string;
  type: "folder";
  name: string;
  items: Array<FolderItem | RequestItem>;
};

export type Collection = {
  id: string;
  name: string;
  items: Array<FolderItem | RequestItem>;
};

export type Environment = {
  id: string;
  name: string;
  vars: EnvVar[];
};

export type HistoryEntry = {
  id: string;
  ts: number;
  requestId: string;
  request: {
    name: string;
    method: HttpMethod;
    url: string;
  };
  response?: {
    status: number;
    ms: number;
    size: number;
  };
  error?: string;
};

export type PersistedState = {
  version: 1;
  collections: Collection[];
  environments: Environment[];
  selectedEnvironmentId?: string;
  selectedRequestId?: string;
  history: HistoryEntry[];
};

export type SendResult = {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  bodyText?: string;
  bodyBase64?: string;
  bodyIsBinary?: boolean;
  ms?: number;
  size?: number;
  error?: string;
};

export type WebviewState = {
  collections: Collection[];
  environments: Environment[];
  selectedEnvironmentId?: string;
  selectedRequest?: RequestItem | null;
  history: HistoryEntry[];
  storageMode?: "workspace" | "global";
  storagePath?: string;
  storageIsCustom?: boolean;
  storageCanOpenFolder?: boolean;
};
