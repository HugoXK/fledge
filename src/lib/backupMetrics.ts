import { readBackupStatus, readRestoreDrill, type BackupStatus, type RestoreDrillStatus } from './backupStatus.js'
import { clearGauge, setGauge } from './metrics.js'

// #693: the backup card answers "is a copy on disk, is it fresh, did the drill
// pass" for the one person who opens `/admin`. Prometheus already scrapes this
// process, so the same two readers publish those answers as gauges — no second
// scheduler and no second file format — and one alert rule can page on them.
//
// The names carry the `fledge_` prefix every other series on the surface has;
// the card that asked for these gauges names them without it. They are written
// as literals at the `setGauge` call sites because `test/sloDefinitions.test.ts`
// reads the recorded series out of the source and holds the catalogue to them.

export interface BackupReadings {
  backup: BackupStatus
  drill: RestoreDrillStatus | null
  /** Hours between the drill record and the render; null when there is no readable record. */
  drillAgeHours: number | null
  /**
   * True only for a successful drill that is inside the expected interval. A
   * missing or malformed `backup-drill.json` is not a passing drill, and with no
   * record at all it is not a failing one either — `publishBackupMetrics` then
   * publishes no verdict series rather than a 0 (#1199).
   */
  drillOk: boolean
}

export interface BackupMetricsInput {
  /** `config.backup.dir`: the directory `npm run db:backup` writes. */
  dir: string
  /** `${config.dataDir}/backup-drill.json`: the record `npm run db:restore-drill` leaves. */
  drillPath: string
  /** `config.backup.expectedIntervalHours`: the stale threshold, shared with the card. */
  expectedHours: number
  /** Injectable so a test can pin the ages instead of racing the clock. */
  now?: number
}

function roundedHours(value: number): number {
  return Math.round(value * 100) / 100
}

export function readBackupReadings(input: BackupMetricsInput): BackupReadings {
  const now = input.now ?? Date.now()
  const backup = readBackupStatus({
    dir: input.dir,
    expectedHours: input.expectedHours,
    // The five series below read the name, the counts and the age; none of them
    // reads the manifest verdict, so the scrape never hashes a copy.
    verifyNewest: false,
    ...(input.now === undefined ? {} : { now: input.now }),
  })
  const drill = readRestoreDrill(input.drillPath)
  const drillAt = drill === null ? Number.NaN : Date.parse(drill.at)
  const drillAgeHours = Number.isFinite(drillAt) ? (now - drillAt) / 3_600_000 : null
  const drillOk = drill !== null && drill.ok && drillAgeHours !== null && drillAgeHours <= input.expectedHours
  return { backup, drill, drillAgeHours, drillOk }
}

/**
 * Publish the five gauges from the readers that already exist.
 *
 * Unknown is absent, per #758: a repository with no copy publishes
 * `backup_age_hours` as no series rather than as a zero, because a zero age
 * reads as "backed up just now". The drill verdict follows the same rule
 * (#1199): with no `backup-drill.json` the gauge is cleared, because the shipped
 * `FledgeRestoreDrillFailing` rule reads `fledge_restore_drill_ok 0` as a drill
 * that ran and failed, and every fresh install fired it for as long as nobody had
 * drilled. `backup_copies` stays a 0 on a fresh install: "no copy on disk" is a
 * real observation, and `FledgeBackupStale` reads the age series, which is absent.
 */
export function publishBackupMetrics(input: BackupMetricsInput): BackupReadings {
  const readings = readBackupReadings(input)
  const ageHours = readings.backup.newest?.ageHours ?? null
  if (ageHours === null || !Number.isFinite(ageHours)) clearGauge('fledge_backup_age_hours')
  else setGauge('fledge_backup_age_hours', roundedHours(ageHours), {}, 'Hours since the newest backup copy was written')
  setGauge('fledge_backup_copies', readings.backup.copies.length, {}, 'Backup copies in the backup directory')
  setGauge('fledge_backup_encrypted_copies', readings.backup.encrypted, {}, 'Encrypted backup copies in the backup directory')
  if (readings.drillAgeHours === null) clearGauge('fledge_restore_drill_age_hours')
  else setGauge('fledge_restore_drill_age_hours', roundedHours(readings.drillAgeHours), {}, 'Hours since the last restore drill')
  // #1199: no record is no verdict, not a failed drill. A record that exists and
  // says no, or one older than the expected interval, still publishes the 0 the
  // rule pages on — it carries an age series, which is what tells the two apart.
  if (readings.drill === null) clearGauge('fledge_restore_drill_ok')
  else setGauge('fledge_restore_drill_ok', readings.drillOk ? 1 : 0, {}, '1 when the last restore drill passed inside the expected interval')
  return readings
}
