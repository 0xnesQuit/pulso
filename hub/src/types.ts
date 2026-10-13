export interface Account {
  id: string;
  tz: string;
  name: string;
  created_at: number;
}

export type AuthVia = "bearer" | "session";

export interface AppEnv {
  Bindings: Env;
  Variables: {
    nonce: string;
    account: Account;
    authVia: AuthVia;
    /** SHA-256 of the current session cookie when authenticated by session. */
    sessionHash: string | null;
  };
}
