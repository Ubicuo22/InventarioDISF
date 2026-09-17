#!/usr/bin/env node
/**
 * scripts/backup-tidb.js — Export real de la BD de Disfruleg a Cloudflare R2
 *
 * Corre como script Node standalone (NO Worker — Dumpling/mysqldump necesitan
 * TCP crudo, que workerd no permite; ver comentario en db/pool.js sobre el
 * shim de `tls`). Pensado para correr por launchd en la Mac Mini
 * (ver ops/com.disfruleg.backup-tidb.plist).
 *
 * Uso: node scripts/backup-tidb.js
 *
 * Por qué Dumpling y no mysqldump: probado en vivo el 13 sep 2026 —
 * `mysqldump --single-transaction` contra este cluster de TiDB Cloud falla
 * con "ROLLBACK TO SAVEPOINT sp does not exist" (falla igual en mysqldump
 * 8.0 y 9.x — incompatibilidad real, no un bug de versión). Dumpling es la
 * herramienta oficial de PingCAP para esto: usa el snapshot MVCC nativo de
 * TiDB (`--consistency snapshot`, default) en vez de SAVEPOINT/transacciones
 * estilo MySQL, así que da una foto consistente de verdad sin ese problema.
 * Instalación: bajar el binario oficial de
 * https://tiup-mirrors.pingcap.com/dumpling-<version>-darwin-<arch>.tar.gz
 * y apuntar DUMPLING_PATH a él (o dejarlo en el PATH).
 *
 * Qué hace:
 *   1. Dumpling vuelca TIDB_DATABASE completa (schema + datos) a un directorio
 *      temporal, con snapshot consistente.
 *   2. Empaqueta el directorio en un único .tar.gz.
 *   3. Sube a R2 bajo db-backups/daily/ (y también weekly/monthly según el día).
 *   4. Aplica retención: 7 diarios, 4 semanales, 3 mensuales.
 *   5. Si algo falla, manda un push de alerta — un backup roto debe notarse.
 */

require('dotenv').config()

const { spawn } = require('child_process')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const os = require('os')

const {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3')

const REQUIRED_ENV = [
  'TIDB_HOST', 'TIDB_USER', 'TIDB_PASSWORD', 'TIDB_DATABASE',
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BACKUP_BUCKET',
]

const RETENTION = { daily: 7, weekly: 4, monthly: 3 }

function faltantes() {
  return REQUIRED_ENV.filter((k) => !process.env[k])
}

function s3Client() {
  const endpoint = process.env.R2_BACKUP_ENDPOINT
    || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
  return new S3Client({
    endpoint,
    region: 'auto',
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  })
}

function timestamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return {
    fecha: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`,
    hora: `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`,
    esDomingo: d.getDay() === 0,
    esPrimerDiaDeMes: d.getDate() === 1,
  }
}

/**
 * Corre Dumpling contra TiDB y vuelca a `destinoDir`.
 *
 * Nota de seguridad: Dumpling no soporta --defaults-extra-file ni MYSQL_PWD
 * (probado en vivo — solo acepta -p en línea de comandos), así que la
 * contraseña sí es visible brevemente en `ps` mientras corre. Riesgo bajo en
 * la Mac Mini (un solo usuario admin), pero es una limitación real de la
 * herramienta, no una elección de diseño — queda documentado por transparencia.
 */
async function dumpConDumpling(destinoDir) {
  const args = [
    '-h', process.env.TIDB_HOST,
    '-P', process.env.TIDB_PORT || '4000',
    '-u', process.env.TIDB_USER,
    '-p', process.env.TIDB_PASSWORD,
    '--database', process.env.TIDB_DATABASE,
    '-o', destinoDir,
  ]

  await new Promise((resolve, reject) => {
    const dumpling = spawn(process.env.DUMPLING_PATH || 'dumpling', args)

    let stderr = ''
    dumpling.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    dumpling.stdout.on('data', () => {}) // dumpling loguea a stderr; stdout normalmente vacío

    dumpling.on('error', reject)
    dumpling.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`dumpling salió con código ${code}: ${stderr.slice(-2000)}`))
      } else {
        resolve()
      }
    })
  })
}

/** Empaqueta el directorio de salida de Dumpling en un único .tar.gz */
async function empaquetar(dirOrigen, destinoTarGz) {
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-czf', destinoTarGz, '-C', path.dirname(dirOrigen), path.basename(dirOrigen)])
    let stderr = ''
    tar.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    tar.on('error', reject)
    tar.on('close', (code) => {
      if (code !== 0) reject(new Error(`tar salió con código ${code}: ${stderr.slice(-1000)}`))
      else resolve()
    })
  })
}

async function subirYRotar(archivoLocalTarGz, nombreArchivo) {
  const s3 = s3Client()
  const bucket = process.env.R2_BACKUP_BUCKET
  const cuerpo = await fsp.readFile(archivoLocalTarGz)
  const { esDomingo, esPrimerDiaDeMes } = timestamp()

  const keyDaily = `db-backups/daily/${nombreArchivo}`
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keyDaily, Body: cuerpo }))
  console.log(`[backup-tidb] Subido: ${keyDaily} (${(cuerpo.length / 1024 / 1024).toFixed(2)} MB)`)

  if (esDomingo) {
    const keyWeekly = `db-backups/weekly/${nombreArchivo}`
    await s3.send(new CopyObjectCommand({
      Bucket: bucket, Key: keyWeekly, CopySource: `${bucket}/${keyDaily}`,
    }))
    console.log(`[backup-tidb] Copiado a weekly: ${keyWeekly}`)
  }

  if (esPrimerDiaDeMes) {
    const keyMonthly = `db-backups/monthly/${nombreArchivo}`
    await s3.send(new CopyObjectCommand({
      Bucket: bucket, Key: keyMonthly, CopySource: `${bucket}/${keyDaily}`,
    }))
    console.log(`[backup-tidb] Copiado a monthly: ${keyMonthly}`)
  }

  for (const [prefijo, cuantosQuedarse] of Object.entries({
    'db-backups/daily/': RETENTION.daily,
    'db-backups/weekly/': RETENTION.weekly,
    'db-backups/monthly/': RETENTION.monthly,
  })) {
    await aplicarRetencion(s3, bucket, prefijo, cuantosQuedarse)
  }
}

async function aplicarRetencion(s3, bucket, prefijo, cuantosQuedarse) {
  const { Contents = [] } = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefijo }))
  if (Contents.length <= cuantosQuedarse) return

  const aBorrar = Contents
    .sort((a, b) => b.Key.localeCompare(a.Key)) // más reciente primero (fecha en el nombre)
    .slice(cuantosQuedarse)

  for (const obj of aBorrar) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }))
    console.log(`[backup-tidb] Retención: borrado ${obj.Key}`)
  }
}

async function alertarFalla(error) {
  try {
    const { enviarATodos } = require('../utils/push')
    await enviarATodos({
      title: '⚠️ Backup de Disfruleg falló',
      body: error.message.slice(0, 180),
    })
  } catch (e) {
    console.error('[backup-tidb] No se pudo enviar la alerta push:', e.message)
  }
}

async function main() {
  const faltan = faltantes()
  if (faltan.length) {
    throw new Error(`Faltan variables de entorno: ${faltan.join(', ')}`)
  }

  const { fecha, hora } = timestamp()
  const nombreArchivo = `disfruleg_${fecha}_${hora}.tar.gz`
  const dirTemporal = path.join(os.tmpdir(), `dumpling-${fecha}_${hora}`)
  const archivoLocalTarGz = path.join(os.tmpdir(), nombreArchivo)

  console.log(`[backup-tidb] Iniciando dump de ${process.env.TIDB_DATABASE} con Dumpling...`)
  await dumpConDumpling(dirTemporal)

  console.log('[backup-tidb] Empaquetando...')
  await empaquetar(dirTemporal, archivoLocalTarGz)

  console.log('[backup-tidb] Subiendo a R2...')
  await subirYRotar(archivoLocalTarGz, nombreArchivo)

  await fsp.rm(dirTemporal, { recursive: true, force: true }).catch(() => {})
  await fsp.unlink(archivoLocalTarGz).catch(() => {})
  console.log('[backup-tidb] Listo.')
}

main()
  .then(() => process.exit(0))
  .catch(async (error) => {
    console.error('[backup-tidb] ERROR:', error.message)
    await alertarFalla(error)
    process.exit(1)
  })
