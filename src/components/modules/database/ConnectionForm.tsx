import { useState, useEffect } from 'react'

import { API } from '../../../utils/apiFetch'

interface ConnectionFormProps {
  editConn: Partial<{
    name: string
    type: 'postgresql' | 'mysql'
    host: string
    port: number
    database: string
    user: string
    password: string
  }>
  setEditConn: (cb: (prev: any) => any) => void
  testing: boolean
  onSave: () => void
  onCancel: () => void
}

// WHY: Controlled form component — editConn state duoc quan ly boi parent (DatabaseModule).
// Auto-doi port khi chuyen db type (PostgreSQL 5432, MySQL 3306).
// Testing flag tu parent disable button + hien spinner.
export default function ConnectionForm({ editConn, setEditConn, testing, onSave, onCancel }: ConnectionFormProps) {
  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-2xl mx-auto w-full">
      <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--fg)' }}>Thêm kết nối database</h2>
      <div className="space-y-4">
        <div>
          <label htmlFor="db-conn-name" className="text-xs font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Tên kết nối</label>
          <input id="db-conn-name" name="name" type="text" value={editConn.name} onChange={e => setEditConn(p => ({ ...p, name: e.target.value }))}
            className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}
            placeholder="My Database" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="db-conn-type" className="text-xs font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Loại</label>
            <select id="db-conn-type" name="type" value={editConn.type} onChange={e => {
              const isPg = e.target.value === 'postgresql'
              setEditConn(p => ({ ...p, type: e.target.value as any, port: isPg ? 5432 : 3306 }))
            }}
              className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500 cursor-pointer"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }}>
              <option value="postgresql">PostgreSQL</option>
              <option value="mysql">MySQL / MariaDB</option>
            </select>
          </div>
          <div>
            <label htmlFor="db-conn-host" className="text-xs font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Host</label>
            <input id="db-conn-host" name="host" type="text" value={editConn.host} onChange={e => setEditConn(p => ({ ...p, host: e.target.value }))}
              className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="db-conn-port" className="text-xs font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Port</label>
            <input id="db-conn-port" name="port" type="number" value={editConn.port} onChange={e => setEditConn(p => ({ ...p, port: parseInt(e.target.value) || 5432 }))}
              className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
          </div>
          <div>
            <label htmlFor="db-conn-database" className="text-xs font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Database</label>
            <input id="db-conn-database" name="database" type="text" value={editConn.database} onChange={e => setEditConn(p => ({ ...p, database: e.target.value }))}
              className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="db-conn-user" className="text-xs font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>User</label>
            <input id="db-conn-user" name="user" type="text" value={editConn.user} onChange={e => setEditConn(p => ({ ...p, user: e.target.value }))}
              className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
          </div>
          <div>
            <label htmlFor="db-conn-password" className="text-xs font-medium block mb-1" style={{ color: 'var(--fg-muted)' }}>Password</label>
            <input id="db-conn-password" name="password" type="password" value={editConn.password} onChange={e => setEditConn(p => ({ ...p, password: e.target.value }))}
              className="w-full border rounded-lg px-3 py-2 text-xs focus:outline-none focus:ring-1 focus:ring-emerald-500"
              style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--input-border)', color: 'var(--fg)' }} />
          </div>
        </div>
        <div className="flex gap-2 justify-end pt-2">
          <button onClick={onCancel}
            className="px-3 py-1.5 text-xs font-medium border rounded-lg transition-colors cursor-pointer"
            style={{ backgroundColor: 'var(--input-bg)', borderColor: 'var(--border)', color: 'var(--fg-secondary)' }}>
            Hủy
          </button>
          <button onClick={onSave} disabled={testing}
            className="px-4 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5 cursor-pointer">
            {testing && <div className="animate-spin rounded-full h-3 w-3 border-b border-white" />}
            {testing ? 'Đang kết nối...' : 'Kiểm tra & Lưu'}
          </button>
        </div>
      </div>
    </div>
  )
}
