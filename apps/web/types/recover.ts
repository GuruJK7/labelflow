import type {
  RecoverConfig as PrismaRecoverConfig,
  RecoverCart as PrismaRecoverCart,
  RecoverMessageLog as PrismaRecoverMessageLog,
  RecoverOptOut as PrismaRecoverOptOut,
  RecoverJob as PrismaRecoverJob,
  CartStatus,
  RecoverSubscriptionStatus,
  RecoverMessageStatus,
} from '@prisma/client'

// Re-export Prisma enums for convenience
export type { CartStatus, RecoverSubscriptionStatus, RecoverMessageStatus }

// Prisma model types
export type RecoverConfig = PrismaRecoverConfig
export type RecoverCart = PrismaRecoverCart
export type RecoverMessageLog = PrismaRecoverMessageLog
export type RecoverOptOut = PrismaRecoverOptOut
export type RecoverJob = PrismaRecoverJob

// Cart item shape stored in RecoverCart.cartItems JSON field
export interface CartItem {
  title: string
  quantity: number
  price: number
  image_url?: string
}

// Dashboard stats aggregation
export interface RecoverStats {
  totalDetected: number
  totalSent: number
  totalRecovered: number
  totalOptedOut: number
  recoveryRate: number
  revenueRecovered: number
}

// API response for cart list with pagination
export interface RecoverCartsResponse {
  carts: RecoverCart[]
  total: number
  page: number
  limit: number
}

// Config update payload (subset of fields the tenant can change)
export interface RecoverConfigUpdate {
  delayMinutes?: number
  secondMessageEnabled?: boolean
  secondMessageDelayMinutes?: number
  messageTemplate1?: string
  messageTemplate2?: string
  optOutKeyword?: string
}
