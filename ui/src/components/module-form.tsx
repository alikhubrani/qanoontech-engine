import { useMemo, useState } from 'react'
import { Badge, Button, Input } from '../components'
import { S } from '../strings'

/**
 * The module configuration form, rendered from the module's own JSON schema —
 * the one derived from the zod schema that also validates. One source, two
 * views; see docs/module-config.md. If a field looks wrong here, the fix is
 * on the schema, not in this file.
 */

interface Property {
  type?: string
  title?: string
  description?: string
  default?: unknown
  enum?: string[]
  minimum?: number
  maximum?: number
  items?: { enum?: string[]; type?: string }
}

export interface ObjectSchema {
  type?: string
  properties?: Record<string, Property>
  required?: string[]
}

export function schemaFields(schema: ObjectSchema): [string, Property][] {
  return Object.entries(schema.properties ?? {})
}

export function SchemaForm({
  schema,
  value,
  onChange,
}: {
  schema: ObjectSchema
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}) {
  const required = useMemo(() => new Set(schema.required ?? []), [schema])

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {schemaFields(schema).map(([name, property]) => (
        <Field
          key={name}
          name={name}
          property={property}
          required={required.has(name)}
          value={value[name]}
          onChange={(fieldValue) => {
            const next = { ...value }
            if (fieldValue === undefined) delete next[name]
            else next[name] = fieldValue
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}

function Field({
  name,
  property,
  required,
  value,
  onChange,
}: {
  name: string
  property: Property
  required: boolean
  value: unknown
  onChange: (next: unknown) => void
}) {
  const label = property.title ?? name
  const help = property.description

  // array of enum → checkbox group
  if (property.type === 'array' && property.items?.enum) {
    const selected = new Set(Array.isArray(value) ? (value as string[]) : (property.default as string[]) ?? [])
    return (
      <Labelled label={label} help={help}>
        <div className="flex flex-wrap gap-3 pt-1">
          {property.items.enum.map((option) => (
            <label key={option} className="flex items-center gap-1.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={selected.has(option)}
                onChange={(event) => {
                  const next = new Set(selected)
                  if (event.target.checked) next.add(option)
                  else next.delete(option)
                  onChange([...next])
                }}
              />
              {option}
            </label>
          ))}
        </div>
      </Labelled>
    )
  }

  if (property.enum) {
    return (
      <Labelled label={label} help={help}>
        <select
          className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          value={String(value ?? property.default ?? '')}
          onChange={(event) => onChange(event.target.value)}
        >
          {!required && <option value="">—</option>}
          {property.enum.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Labelled>
    )
  }

  if (property.type === 'boolean') {
    return (
      <Labelled label={label} help={help}>
        <label className="flex items-center gap-2 pt-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={Boolean(value ?? property.default ?? false)}
            onChange={(event) => onChange(event.target.checked)}
          />
          {label}
        </label>
      </Labelled>
    )
  }

  if (property.type === 'integer' || property.type === 'number') {
    return (
      <Labelled label={label} help={help}>
        <Input
          type="number"
          min={property.minimum}
          max={property.maximum}
          value={value === undefined || value === null ? '' : String(value)}
          placeholder={property.default !== undefined ? String(property.default) : undefined}
          onChange={(event) => {
            const raw = event.target.value
            onChange(raw === '' ? undefined : Number(raw))
          }}
        />
      </Labelled>
    )
  }

  // default: string
  return (
    <Labelled label={label} help={help}>
      <Input
        value={String(value ?? '')}
        placeholder={property.default !== undefined ? String(property.default) : undefined}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
      />
    </Labelled>
  )
}

function Labelled({ label, help, children }: { label: string; help?: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1 text-sm">
      <span className="font-medium text-slate-600">{label}</span>
      {children}
      {help && <span className="block text-xs text-slate-400">{help}</span>}
    </label>
  )
}

// ---------------------------------------------------------------------------

export interface SecretDeclaration {
  name: string
  title: string
  help: string
  kind: 'json' | 'token' | 'text'
  set: boolean
}

/**
 * Secret fields: write-only by construction. A stored secret shows as a
 * badge, never a value; entering something replaces it. The JSON kind takes
 * a file too, because a service-account key is a file someone downloaded,
 * not a string someone knows.
 */
export function SecretFields({
  secrets,
  values,
  onChange,
}: {
  secrets: SecretDeclaration[]
  values: Record<string, string>
  onChange: (next: Record<string, string>) => void
}) {
  return (
    <div className="space-y-3">
      {secrets.map((secret) => (
        <SecretField
          key={secret.name}
          secret={secret}
          value={values[secret.name] ?? ''}
          onChange={(fieldValue) => {
            const next = { ...values }
            if (fieldValue === '') delete next[secret.name]
            else next[secret.name] = fieldValue
            onChange(next)
          }}
        />
      ))}
    </div>
  )
}

function SecretField({
  secret,
  value,
  onChange,
}: {
  secret: SecretDeclaration
  value: string
  onChange: (next: string) => void
}) {
  const [fileName, setFileName] = useState<string | null>(null)

  return (
    <div className="space-y-1 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium text-slate-600">{secret.title}</span>
        {secret.set && <Badge tone="ok">{S.secretSet}</Badge>}
      </div>
      {secret.kind === 'json' ? (
        <div className="space-y-1.5">
          <textarea
            className="h-20 w-full rounded-md border border-slate-300 p-2 font-mono text-xs outline-none focus:border-brand"
            value={value}
            placeholder={secret.set ? S.secretReplacePlaceholder : '{ … }'}
            onChange={(event) => {
              setFileName(null)
              onChange(event.target.value)
            }}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => document.getElementById(`file-${secret.name}`)?.click()}
            >
              {S.secretChooseFile}
            </Button>
            {fileName && <span className="text-xs text-slate-400">{fileName}</span>}
            <input
              id={`file-${secret.name}`}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (!file) return
                void file.text().then((text) => {
                  setFileName(file.name)
                  onChange(text)
                })
              }}
            />
          </div>
        </div>
      ) : (
        <Input
          type={secret.kind === 'token' ? 'password' : 'text'}
          value={value}
          placeholder={secret.set ? S.secretReplacePlaceholder : ''}
          autoComplete="off"
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      <span className="block text-xs text-slate-400">{secret.help}</span>
    </div>
  )
}
