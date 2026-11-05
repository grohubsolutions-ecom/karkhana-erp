export type Dept = { id: string; code: string; name: string; kind: string | null; parent_id: string | null; is_active: boolean | null };
export type Shift = {
  id: string; name: string; start_time: string; end_time: string; break_minutes: number;
  late_grace_minutes: number; early_grace_minutes: number; half_day_minutes: number | null;
  overtime_after_minutes: number; off_weekdays: number[]; is_active: boolean;
};
export type Settings = {
  employee_id: string; device_user_id: string | null; shift_id: string | null;
  working_days_per_month: number; late_cut_enabled: boolean; overtime_enabled: boolean; overtime_multiplier: number;
};
export type Staff = {
  id: string; code: string; name: string; phone: string | null; department_id: string | null;
  is_active: boolean; join_date: string | null; pay_type: string | null; pay_amount: number | null;
  departments: { name: string | null } | null;
};
export type Day = {
  employee_id: string; att_date: string; first_in: string | null; last_out: string | null; worked_minutes: number;
  late_minutes: number; early_minutes: number; overtime_minutes: number; overtime_approved_minutes: number;
  status: string; is_manual: boolean; note: string | null;
  scheduled_minutes?: number; extra_overtime_minutes?: number; extra_overtime_note?: string | null;
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const PAY_TYPES = ["Monthly", "Daily", "Hourly", "Piece-rate"];
export const STATUS_LABEL: Record<string, string> = {
  pending: "Not in yet", in_progress: "At work", present: "Present", half_day: "Half day", absent: "Absent",
  missing_out: "Missing punch-out", off: "Off day", holiday: "Holiday", worked_off: "Worked off day",
  paid_leave: "Paid leave", no_shift: "No shift",
};

export const money = (v: unknown) => "Rs " + Math.round(Number(v) || 0).toLocaleString("en-PK");
export const hours = (mins: unknown) => {
  const m = Number(mins) || 0;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
};
export const karachiTime = (v: string | null) =>
  v ? new Date(v).toLocaleTimeString("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit" }) : "—";
export const karachiDate = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Karachi" });
export const hhmm = (t: string) => t.slice(0, 5);

/* Supabase can type a joined row as an array even when it resolves to one row. */
export function flatStaff(rows: unknown): Staff[] {
  return ((rows ?? []) as Record<string, unknown>[]).map((r) => ({
    ...r,
    departments: Array.isArray(r.departments) ? r.departments[0] ?? null : r.departments,
  })) as unknown as Staff[];
}

export const STAFF_FIELDS = "id,code,name,phone,department_id,is_active,join_date,pay_type,pay_amount,departments(name)";
