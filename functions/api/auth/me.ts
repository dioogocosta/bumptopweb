import type { PagesFunction } from '../_types';
import { getSessionUser, jsonResponse } from '../_auth';

export const onRequestGet: PagesFunction = async (context) => {
  const { request, env } = context;

  if (!env.DB) {
    return jsonResponse({ ok: true, user: null });
  }

  const user = await getSessionUser(env.DB, request);
  return jsonResponse({ ok: true, user });
};
