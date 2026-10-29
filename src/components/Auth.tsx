import { useState, type FormEvent } from 'react'
import { api } from '../lib/api.ts'
import { deriveIdentity } from '../lib/crypto.ts'
import { saveIdentity, type StoredIdentity } from '../lib/keystore.ts'
import { Lock } from './icons.tsx'

const field = 'min-h-12 w-full rounded-2xl bg-surface px-4'

export default function Auth({ invite, onDone }: { invite: string | null; onDone: (id: StoredIdentity) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>(invite ? 'register' : 'login')
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (mode === 'register') {
      if (pass.length < 12) return setError('Use at least 12 characters. A few random words works well.')
      if (pass !== confirm) return setError('The passphrases do not match.')
    }
    setBusy(true)
    setError('')
    try {
      const ident = await deriveIdentity(n, pass)
      const { id } =
        mode === 'register'
          ? await api<{ id: string }>('POST', '/api/register', { invite, name: n, pubkey: ident.publicKey, auth: ident.auth })
          : await api<{ id: string }>('POST', '/api/login', { name: n, auth: ident.auth })
      const stored = { userId: id, name: n, privateKey: ident.privateKey }
      await saveIdentity(stored)
      history.replaceState(null, '', '/')
      onDone(stored)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const register = mode === 'register'
  return (
    <main className="pt-safe pb-safe flex min-h-full items-center justify-center px-6">
      <form onSubmit={submit} className="rise flex w-full max-w-sm flex-col">
        <h1 className="text-[3.5rem] font-bold leading-none tracking-[-0.04em]">Talk</h1>
        <p className="mb-8 mt-3 text-lg text-mut">
          {register ? 'You\u2019re invited. Choose a name and a passphrase.' : 'Private messages and calls for you and your people.'}
        </p>

        <label htmlFor="name" className="mb-1.5 text-sm font-medium">Name</label>
        <input id="name" className={field} autoComplete="username" autoCapitalize="words" value={name} onChange={(e) => setName(e.target.value)} required maxLength={32} />

        <label htmlFor="pass" className="mb-1.5 mt-4 text-sm font-medium">Passphrase</label>
        <input
          id="pass"
          className={field}
          type="password"
          autoComplete={register ? 'new-password' : 'current-password'}
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          aria-describedby="pass-help"
          required
        />
        <p id="pass-help" className="mt-1.5 flex items-start gap-1.5 text-sm text-mut">
          <span className="mt-0.5 shrink-0"><Lock size={14} /></span>
          {register
            ? 'At least 12 characters; four random words works well. It never leaves this device, and it can\u2019t be reset: forget it and your messages are gone.'
            : 'Same name and passphrase on every device you use.'}
        </p>

        {register && (
          <>
            <label htmlFor="confirm" className="mb-1.5 mt-4 text-sm font-medium">Passphrase again</label>
            <input id="confirm" className={field} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </>
        )}

        {error && <p className="mt-4 text-sm font-medium text-danger" role="alert">{error}</p>}
        <button disabled={busy} className="pressable mt-6 min-h-12 rounded-full bg-fill px-6 font-semibold text-white disabled:opacity-50">
          {busy ? 'Unlocking\u2026' : register ? 'Create account' : 'Sign in'}
        </button>
        {invite && (
          <button type="button" onClick={() => { setMode(register ? 'login' : 'register'); setError('') }} className="mt-2 min-h-11 text-sm font-medium text-accent">
            {register ? 'I already have an account' : 'New here? Create an account'}
          </button>
        )}
      </form>
    </main>
  )
}
