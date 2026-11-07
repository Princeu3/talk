import { api } from './api.ts'
import { b64, unb64 } from './crypto.ts'

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window

// iOS only allows web push for apps added to the home screen.
export const needsInstall = () =>
  /iPhone|iPad/.test(navigator.userAgent) && !(navigator as { standalone?: boolean }).standalone

export async function subscribe(vapidPublicKey: string) {
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  // A subscription made under another server key gets 403 on every push: replace it.
  const key = sub?.options.applicationServerKey
  if (sub && key && b64(new Uint8Array(key)) !== b64(unb64(vapidPublicKey))) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64(vapidPublicKey) })
  await api('POST', '/api/push', { subscription: sub.toJSON() })
}

export async function enablePush(vapidPublicKey: string) {
  if ((await Notification.requestPermission()) !== 'granted') return false
  await subscribe(vapidPublicKey)
  return true
}
