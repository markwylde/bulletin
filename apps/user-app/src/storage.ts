import { loadStorageEnvironment } from "@bulletin/config/storage";
import { createStorage } from "@bulletin/storage";

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development";

/** User-app only presigns public/user-content URLs; it never mutates the bucket (ADR 0019). */
export const storage = createStorage(loadStorageEnvironment(process.env, nodeEnv));
