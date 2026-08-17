import { sign, verify } from 'hono/jwt'
import type { Context } from 'hono'

const JWT_SECRET = process.env.JWT_SECRET || 'rabbit-dev-secret-change-in-production'
const JWT_EXPIRES_IN = 7 * 24 * 60 * 60 // 7 days in seconds

export interface JwtPayload {
  userId: number
  username: string
  role: 'admin' | 'user'
  exp: number
}

export const signToken = async (payload: Omit<JwtPayload, 'exp'>): Promise<string> => {
  return sign(
    { ...payload, exp: Math.floor(Date.now() / 1000) + JWT_EXPIRES_IN },
    JWT_SECRET,
    'HS256',
  )
}

export const verifyToken = async (token: string): Promise<JwtPayload> => {
  const payload = await verify(token, JWT_SECRET, 'HS256')
  return payload as unknown as JwtPayload
}

export const getJwtSecret = () => JWT_SECRET

export const getJwtPayload = (c: Context): JwtPayload => {
  return c.get('jwtPayload') as JwtPayload
}
