import type { APIRoute } from "astro";
import { avatarImageResponse } from "../../../avatars/image.ts";
import { storage } from "../../../storage.ts";

/** `GET /avatars/<member>/<hash>-<size>.webp` (task 5.2). */
export const GET: APIRoute = ({ params }) =>
  avatarImageResponse(storage, params.member ?? "", params.file ?? "");
