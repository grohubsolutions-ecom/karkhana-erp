"use client";
/* ARTICLES LIST — every garment saved so far, with its recipe, edit and delete.
 *
 * This used to be its own page under Factory → Articles. It now sits beside
 * the Add New Article form, so the thing you just made and everything made
 * before it are on one screen: add on the left, check it landed on the right.
 *
 * The code is the old Articles page moved here as it was. Adding is done by
 * the form beside it, so this list opens its modal only for editing — the
 * add branch inside that modal is kept but has no button leading to it.
 */
import { useEffect, useState, useCallback } from "react";
import { supabase, isSupabaseConfigured } from "@/lib/supabase";
import { Loader2, Plus, Pencil, Shirt, X, Trash2, BookOpen } from "lucide-react";

type Cat = { id: string; name: string };
type Group = { id: string; name: string; has_category: boolean; has_size: boolean; units: { id: string; symbol: string }[]; categories: Cat[] };
type Article = { id: string; code: string; name: string; garment_type: string | null;
                 audience: string | null; size: string | null; notes: string | null;
                 is_active: boolean; created_at: string; bomCount: number;
                 /* K148 */
                 section: string | null; system_barcode: string | null;
                 manual_barcode: string | null; cost_price: number | null;
                 retail_price: number | null; gst_rate: number | null;
                 /* K184 — which warehouse product this article becomes. */
                 warehouse_item_id: string | null };
type WhOption = { item_id: string; barcode: string; name: string; manual_barcode: string | null };
type BomLine = { group_id: string; category_id: string; size_id: string; quantity: string; unit_id: string };

const AUDIENCES = ["Kids", "Men", "Ladies", "Unisex"];
const when = (s: string) => new Date(s).toLocaleString("en-PK", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });

type Props = {
  /* Bumped by the page whenever the form saves, so the new article appears
     here without a manual refresh. */
  reloadKey?: number;
  /* The barcode of an article whose recipe should open — set by the form's
     "Add its recipe" button right after a save. */
  recipeFor?: string | null;
  onRecipeOpened?: () => void;
};

export default function ArticlesList({ reloadKey = 0, recipeFor: openFor = null, onRecipeOpened }: Props) {
  const [articles, setArticles] = useState<Article[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [sizes, setSizes] = useState<{ id: string; name: string }[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);

  const [artModal, setArtModal] = useState<null | { id?: string; bc?: string | null }>(null);
  const [name, setName] = useState(""); const [gtype, setGtype] = useState(""); const [aud, setAud] = useState("");
  const [size, setSize] = useState(""); const [notes, setNotes] = useState(""); const [active, setActive] = useState(true);
  const [savingArt, setSavingArt] = useState(false); const [artErr, setArtErr] = useState("");

  const [recipeFor, setRecipeFor] = useState<Article | null>(null);
  const [lines, setLines] = useState<BomLine[]>([]);
  const [recipeLoading, setRecipeLoading] = useState(false);
  const [savingRecipe, setSavingRecipe] = useState(false); const [recipeErr, setRecipeErr] = useState("");
  const [deleteFor, setDeleteFor] = useState<Article | null>(null); const [deleting, setDeleting] = useState(false); const [deleteErr, setDeleteErr] = useState("");
  /* K184 — the warehouse products an article can be matched to, and which row
     is being matched right now. Read through an RPC rather than the warehouse
     views, which are behind khana.view: someone working on factory articles
     has no reason to hold that. */
  const [whOptions, setWhOptions] = useState<WhOption[]>([]);
  const [matching, setMatching] = useState<string | null>(null);
  const [matchErr, setMatchErr] = useState("");

  /* K184 — match an article to the warehouse product it becomes. The database
     holds the one-to-one: a product already spoken for is refused by name. */
  async function matchTo(a: Article, itemId: string) {
    if (!supabase) return;
    setMatchErr(""); setMatching(a.id);
    const { error } = await supabase.rpc("set_article_warehouse_link", {
      p_article: a.id, p_item: itemId || null,
    });
    setMatching(null);
    if (error) { setMatchErr(error.message); return; }
    load();
  }

  const load = useCallback(async () => {
    if (!supabase) return;
    setLoading(true);
    const [a, g, sz, pm, wh] = await Promise.all([
      supabase.from("articles").select("id,code,name,garment_type,audience,size,notes,is_active,created_at,section,system_barcode,manual_barcode,cost_price,retail_price,gst_rate,warehouse_item_id, article_bom(count)").order("code", { ascending: false }),
      supabase.from("material_groups").select("id,name,has_category,has_color,has_size, group_units(units(id,symbol)), material_categories(id,name)").eq("is_active", true).order("name"),
      supabase.from("sizes").select("id,name").eq("is_active", true).order("sort_order"),
      supabase.rpc("has_permission", { p_permission_code: "production.manage" }),
      supabase.rpc("warehouse_product_options"),
    ]);
    setWhOptions((wh.data as WhOption[]) ?? []);
    setArticles(((a.data as unknown as Record<string, unknown>[]) ?? []).map((r) => {
      const bc = (r.article_bom as { count: number }[] | null)?.[0]?.count ?? 0;
      const num = (v: unknown) => (v == null ? null : Number(v));
      return { id: r.id as string, code: r.code as string, name: r.name as string,
        garment_type: (r.garment_type as string) || null, audience: (r.audience as string) || null,
        size: (r.size as string) || null, notes: (r.notes as string) || null,
        is_active: !!r.is_active, created_at: r.created_at as string, bomCount: Number(bc),
        /* K148 — extended the type and the query last round but not the
           mapper in between, which is what the build caught. */
        section: (r.section as string) || null,
        system_barcode: (r.system_barcode as string) || null,
        manual_barcode: (r.manual_barcode as string) || null,
        cost_price: num(r.cost_price), retail_price: num(r.retail_price),
        gst_rate: num(r.gst_rate),
        warehouse_item_id: (r.warehouse_item_id as string) || null };
    }));
    setGroups(((g.data as unknown as Record<string, unknown>[]) ?? []).map((r) => {
      const gu = (r.group_units as { units: { id: string; symbol: string } | null }[]) ?? [];
      const cats = (r.material_categories as Cat[]) ?? [];
      return { id: r.id as string, name: r.name as string, has_category: !!r.has_category, has_size: !!r.has_size, units: gu.map((x) => x.units).filter(Boolean) as { id: string; symbol: string }[], categories: cats };
    }));
    setSizes((sz.data as { id: string; name: string }[]) ?? []);
    setCanManage(!!pm.data);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load, reloadKey]);

  function openAdd() { setArtModal({}); setName(""); setGtype(""); setAud(""); setSize(""); setNotes(""); setActive(true); setArtErr("");
    setSection(""); setManualBc(""); setCost(""); setRetail(""); setGst(""); setMadeBc(null); }
  function openEdit(a: Article) { setArtModal({ id: a.id, bc: a.system_barcode }); setName(a.name); setGtype(a.garment_type || ""); setAud(a.audience || ""); setSize(a.size || ""); setNotes(a.notes || ""); setActive(a.is_active); setArtErr("");
    setSection(a.section || ""); setManualBc(a.manual_barcode || "");
    setCost(a.cost_price == null ? "" : String(a.cost_price));
    setRetail(a.retail_price == null ? "" : String(a.retail_price));
    setGst(a.gst_rate == null ? "" : String(a.gst_rate)); setMadeBc(null); }

  /* K148 fields. The system barcode is NOT here — it is generated on save
     and can never be typed, which is why two people cannot invent the same
     one. */
  const [section, setSection] = useState("");
  const [manualBc, setManualBc] = useState("");
  const [cost, setCost] = useState("");
  const [retail, setRetail] = useState("");
  const [gst, setGst] = useState("");
  const [madeBc, setMadeBc] = useState<string | null>(null);

  async function saveArticle() {
    setArtErr(""); if (!supabase) return;
    if (!name.trim()) { setArtErr("Enter an article name."); return; }
    setSavingArt(true);
    if (artModal?.id) {
      /* One call, every field. This used to be two: a function for the name,
         then a direct write for the barcode and prices. That direct write
         never saved anything — the articles table only allows reading, and a
         blocked write comes back as "0 rows changed", not as an error — so the
         window closed as if it had worked while the old barcode stayed put.
         update_article_details (K177) saves it all or refuses it all, and a
         refusal arrives here as a message. */
      const { error } = await supabase.rpc("update_article_details", {
        p_id: artModal.id,
        p_patch: {
          name: name.trim(), garment_type: gtype, audience: aud, size, notes, is_active: active,
          section: section || null,
          manual_barcode: manualBc.trim() || null,
          cost_price: cost ? parseFloat(cost) : null,
          retail_price: retail ? parseFloat(retail) : null,
          gst_rate: gst ? parseFloat(gst) : null,
        },
      });
      setSavingArt(false);
      if (error) { setArtErr(error.message); return; }
      setArtModal(null); load();
      return;
    }

    if (!section) { setSavingArt(false); setArtErr("Which section does it belong to?"); return; }
    const { data, error } = await supabase.rpc("add_article", {
      p_name: name.trim(), p_section: section,
      p_manual_barcode: manualBc.trim() || null,
      p_garment_type: gtype || null, p_size: size || null,
      p_cost_price: cost ? parseFloat(cost) : null,
      p_retail_price: retail ? parseFloat(retail) : null,
      p_gst_rate: gst ? parseFloat(gst) : null, p_code: null,
    });
    setSavingArt(false);
    if (error) { setArtErr(error.message); return; }
    /* Show the generated barcode before closing — otherwise somebody must go
       and look it up before printing a tag. */
    setMadeBc(String((data as Record<string, unknown>)?.system_barcode ?? ""));
    load();
  }

  const groupById = (id: string) => groups.find((g) => g.id === id);
  const unitsFor = (id: string) => groupById(id)?.units ?? [];
  const catsFor = (id: string) => groupById(id)?.categories ?? [];

  async function openRecipe(a: Article) {
    setRecipeFor(a); setLines([]); setRecipeErr(""); setRecipeLoading(true);
    if (!supabase) return;
    const { data } = await supabase.from("article_bom").select("group_id,category_id,size_id,quantity,unit_id").eq("article_id", a.id);
    const existing = ((data as { group_id: string; category_id: string | null; size_id: string | null; quantity: number; unit_id: string }[]) ?? [])
      .map((r) => ({ group_id: r.group_id, category_id: r.category_id || "", size_id: r.size_id || "", quantity: String(Number(r.quantity)), unit_id: r.unit_id }));
    setLines(existing.length ? existing : [{ group_id: "", category_id: "", size_id: "", quantity: "", unit_id: "" }]);
    setRecipeLoading(false);
  }
  function setLine(i: number, patch: Partial<BomLine>) {
    setLines((ls) => ls.map((l, idx) => {
      if (idx !== i) return l;
      const next = { ...l, ...patch };
      if (patch.group_id !== undefined) { const us = unitsFor(patch.group_id); next.unit_id = us.length === 1 ? us[0].id : ""; next.category_id = ""; next.size_id = ""; }
      return next;
    }));
  }
  const addLine = () => setLines((ls) => [...ls, { group_id: "", category_id: "", size_id: "", quantity: "", unit_id: "" }]);
  const removeLine = (i: number) => setLines((ls) => (ls.length === 1 ? ls : ls.filter((_, idx) => idx !== i)));

  /* The form beside this list asked for a recipe to open. Waits for the
     article to be in the list — it was saved a moment ago and the reload
     may still be running — then opens it once and says so. */
  useEffect(() => {
    if (!openFor || loading) return;
    const a = articles.find((x) => x.system_barcode === openFor);
    if (a) { openRecipe(a); onRecipeOpened?.(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFor, loading, articles]);

  async function saveRecipe() {
    setRecipeErr(""); if (!supabase || !recipeFor) return;
    const valid = lines.filter((l) => l.group_id && l.unit_id && parseFloat(l.quantity) > 0);
    setSavingRecipe(true);
    const p_lines = valid.map((l) => ({ group_id: l.group_id, category_id: l.category_id || null, size_id: l.size_id || null, quantity: parseFloat(l.quantity), unit_id: l.unit_id }));
    const { error } = await supabase.rpc("set_article_bom", { p_article_id: recipeFor.id, p_lines });
    setSavingRecipe(false);
    if (error) { setRecipeErr(error.message); return; }
    setRecipeFor(null); load();
  }

  async function doDelete() {
    setDeleteErr(""); if (!supabase || !deleteFor) return;
    setDeleting(true);
    const { error } = await supabase.rpc("delete_article", { p_id: deleteFor.id });
    setDeleting(false);
    if (error) { setDeleteErr(error.message); return; }
    setDeleteFor(null); load();
  }

  return (
    <>
      <div>
        {!isSupabaseConfigured ? (
          <div className="rounded-card bg-surface p-8 text-center text-[14px] text-muted shadow-card">Connect Supabase to manage articles.</div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-muted"><Loader2 size={18} className="animate-spin" /> Loading…</div>
        ) : (
          <>
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <p className="text-[13px] font-semibold text-ink">All articles <span className="font-normal text-hint">· {articles.length}</span></p>
              <p className="text-[12px] text-muted">Set each one&apos;s <b>recipe</b> so orders can work out the material.{!canManage && " (View only.)"}</p>
            </div>

            {articles.length === 0 ? (
              <div className="rounded-card bg-surface p-10 text-center shadow-card">
                <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-panel text-ink"><Shirt size={26} /></span>
                <p className="mt-3 text-[15px] font-semibold text-ink">No articles yet</p>
                <p className="mt-1 text-[13px] text-muted">Add your first garment with the form.</p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-card bg-surface shadow-card">
                {/* The database's own words when a match is refused — on the
                    list being looked at, not at the top of the page. */}
                {matchErr && (
                  <p className="border-b border-danger/25 bg-danger-soft px-4 py-2.5 text-[12.5px] font-medium text-ink">{matchErr}</p>
                )}
                <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"><table className="w-full text-left text-[13.5px]">
                  <thead><tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
                    <th className="px-3 py-2.5 font-semibold">Barcode</th><th className="px-3 py-2.5 font-semibold">Article</th>
                    <th className="px-3 py-2.5 font-semibold">Type</th>
                    <th className="px-3 py-2.5 font-semibold">Recipe</th>
                    {/* K184 — the warehouse product this article becomes.
                        Empty on all of them until they are matched by hand. */}
                    <th className="px-3 py-2.5 font-semibold">Warehouse description</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Cost</th>
                    <th className="px-3 py-2.5 text-right font-semibold">Retail</th>
                    <th className="px-3 py-2.5 text-right font-semibold">GST</th>
                    <th className="px-3 py-2.5"></th>
                  </tr></thead>
                  <tbody>
                    {articles.map((a) => (
                      <tr key={a.id} className={`border-b border-line/60 last:border-0 ${a.is_active ? "" : "opacity-55"}`}>
                        <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[12px]">
                          {a.system_barcode
                            ? <span className="text-[13.5px] font-bold text-ink">{a.system_barcode}</span>
                            : <span className="text-hint">no barcode</span>}
                          {a.manual_barcode && (
                            <span className="block text-[11px] text-muted">also {a.manual_barcode}</span>
                          )}
                        </td>
                        <td className="min-w-[180px] px-3 py-2.5 font-semibold text-ink">
                          {a.name}
                          {/* Status used to be a column that said "Active" on every row.
                              Beside the form there is no room for a column of the
                              obvious, so only the exception is marked. */}
                          {!a.is_active && <span className="ml-1.5 whitespace-nowrap rounded-full bg-panel px-1.5 py-0.5 align-middle text-[10.5px] font-semibold text-muted">Inactive</span>}
                        </td>
                        <td className="px-3 py-2.5 text-ink/70">
                          {a.garment_type || (a.audience ? "" : "—")}
                          {a.audience && <span className="block text-[11.5px] text-hint">{a.audience}</span>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5">{a.bomCount > 0 ? <span className="rounded-full bg-success-soft px-2 py-0.5 text-[11.5px] font-semibold text-[#166534]">{a.bomCount} material{a.bomCount > 1 ? "s" : ""}</span> : <span className="rounded-full bg-panel px-2 py-0.5 text-[11.5px] font-semibold text-muted">Not set</span>}</td>
                        <td className="min-w-[210px] px-3 py-2.5">
                          {canManage ? (
                            <select value={a.warehouse_item_id ?? ""} disabled={matching === a.id}
                              onChange={(e) => matchTo(a, e.target.value)}
                              className={`w-full rounded-lg border px-2 py-1 text-[12px] outline-none ${a.warehouse_item_id ? "border-line text-ink" : "border-dashed border-line text-hint"}`}>
                              <option value="">not matched yet</option>
                              {whOptions.map((w) => (
                                <option key={w.item_id} value={w.item_id}>
                                  {w.name}{w.manual_barcode ? ` · ${w.manual_barcode}` : ""}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <span className="text-[12.5px] text-ink/70">
                              {whOptions.find((w) => w.item_id === a.warehouse_item_id)?.name ?? "—"}
                            </span>
                          )}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right tnum text-[12.5px] text-muted">
                          {a.cost_price == null ? "—" : `Rs ${Number(a.cost_price).toLocaleString()}`}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right tnum text-[13px] font-semibold text-ink">
                          {a.retail_price == null ? "—" : `Rs ${Number(a.retail_price).toLocaleString()}`}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2.5 text-right tnum text-[12.5px] text-muted">
                          {a.gst_rate == null ? "—" : `${a.gst_rate}%`}
                          {a.retail_price != null && a.gst_rate != null && (
                            <span className="block text-[11px] text-hint">
                              Rs {(Number(a.retail_price) * (1 + Number(a.gst_rate) / 100)).toLocaleString(undefined, { maximumFractionDigits: 0 })} inc
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5"><div className="flex justify-end gap-1">
                          <button onClick={() => openRecipe(a)} className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel"><BookOpen size={13} /> Recipe</button>
                          {canManage && <button onClick={() => openEdit(a)} className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink/70 hover:bg-panel"><Pencil size={13} /> Edit</button>}
                          {canManage && <button onClick={() => setDeleteFor(a)} className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1.5 text-[12px] font-semibold text-danger hover:bg-danger-soft"><Trash2 size={13} /> Delete</button>}
                        </div></td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              </div>
            )}
          </>
        )}
      </div>

      {artModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={() => !savingArt && setArtModal(null)}>
          <div className="w-full max-w-md rounded-card bg-surface p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
            {madeBc && (
              <div className="mb-3 rounded-xl2 border border-[#166534]/25 bg-success-soft p-4 text-center">
                <p className="text-[12px] font-bold uppercase tracking-wide text-ink/55">System barcode</p>
                <p className="mt-1 font-mono text-[28px] font-extrabold tracking-tight text-ink">{madeBc}</p>
                <div className="mt-2.5 flex justify-center gap-2">
                  {/* The recipe is the thing people forget, and an article
                      without one cannot be ordered. Offer it while they are
                      still here rather than hoping they come back. */}
                  <button onClick={() => { const made = articles.find((x) => x.system_barcode === madeBc); setArtModal(null); if (made) openRecipe(made); }}
                    className="rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-semibold text-white">Add its recipe</button>
                  <button onClick={openAdd} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink/70">Add another</button>
                </div>
              </div>
            )}
            <div className="mb-3 flex items-center justify-between"><h2 className="text-[16px] font-extrabold">{artModal.id ? "Edit article" : "Add article"}</h2><button onClick={() => setArtModal(null)} className="rounded-full p-1.5 text-muted hover:bg-panel"><X size={18} /></button></div>
            <label className="block text-[12px] font-medium text-muted">Article name *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kids Cotton Shirt" className={inp} autoFocus />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div><label className="block text-[12px] font-medium text-muted">Garment type</label><input value={gtype} onChange={(e) => setGtype(e.target.value)} placeholder="Shirt / Trouser" className={inp} /></div>
              <div><label className="block text-[12px] font-medium text-muted">Audience</label><select value={aud} onChange={(e) => setAud(e.target.value)} className={inp}><option value="">—</option>{AUDIENCES.map((x) => <option key={x} value={x}>{x}</option>)}</select></div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div><label className="block text-[12px] font-medium text-muted">Size (optional)</label><input value={size} onChange={(e) => setSize(e.target.value)} placeholder="e.g. 2-6Y" className={inp} /></div>
              {artModal.id && <div><label className="block text-[12px] font-medium text-muted">Status</label><select value={active ? "1" : "0"} onChange={(e) => setActive(e.target.value === "1")} className={inp}><option value="1">Active</option><option value="0">Inactive</option></select></div>}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <div><label className="block text-[12px] font-medium text-muted">Section {artModal.id ? "" : "*"}</label>
                {/* Locked once a barcode exists: 44-000001 says section 44 in its
                    first two digits, and the barcode is never re-made on edit.
                    The database refuses the change too — this just says so first. */}
                <select value={section} onChange={(e) => setSection(e.target.value)} className={`${inp} disabled:cursor-not-allowed disabled:opacity-55`}
                  disabled={!!artModal.bc} title={artModal.bc ? `Fixed by its barcode ${artModal.bc}` : undefined}>
                  <option value="">—</option>
                  <option value="40">40 · Baby/Newborn</option>
                  <option value="41">41 · Kids</option>
                  <option value="42">42 · Child</option>
                  <option value="43">43 · Ladies</option>
                  <option value="44">44 · Men</option>
                  <option value="60">60 · Shoes</option>
                  <option value="61">61 · Accessories</option>
                </select></div>
              <div><label className="block text-[12px] font-medium text-muted">Manual barcode</label>
                <input value={manualBc} onChange={(e) => setManualBc(e.target.value)} placeholder="if one already exists" className={inp} /></div>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-3">
              <div><label className="block text-[12px] font-medium text-muted">Cost price</label>
                <input type="number" value={cost} onChange={(e) => setCost(e.target.value)} className={inp} /></div>
              <div><label className="block text-[12px] font-medium text-muted">Retail price</label>
                <input type="number" value={retail} onChange={(e) => setRetail(e.target.value)} className={inp} /></div>
              <div><label className="block text-[12px] font-medium text-muted">GST %</label>
                <input type="number" value={gst} onChange={(e) => setGst(e.target.value)} placeholder="18" className={inp} /></div>
            </div>
            {cost && retail && (
              <p className="mt-2 text-[12px] text-ink/70">
                Margin <b>Rs {(parseFloat(retail) - parseFloat(cost)).toLocaleString()}</b>
                {gst ? ` · GST Rs ${(parseFloat(retail) * parseFloat(gst) / 100).toFixed(0)}` : ""}
              </p>
            )}
            {!artModal.id && <p className="mt-2 text-[12px] text-hint">Barcode is generated on save — {section || "??"}-000001 upward, counting inside its own section.</p>}
            <label className="mt-3 block text-[12px] font-medium text-muted">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" className={inp} />
            {artErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{artErr}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setArtModal(null)} disabled={savingArt} className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
              <button onClick={saveArticle} disabled={savingArt} className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">{savingArt && <Loader2 size={15} className="animate-spin" />}{artModal.id ? "Save changes" : "Add new article"}</button>
            </div>
          </div>
        </div>
      )}

      {recipeFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={() => !savingRecipe && setRecipeFor(null)}>
          <div className="max-h-[88vh] w-full max-w-lg overflow-y-auto rounded-card bg-surface p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 flex items-center justify-between"><h2 className="text-[16px] font-extrabold">Recipe · {recipeFor.name}</h2><button onClick={() => setRecipeFor(null)} className="rounded-full p-1.5 text-muted hover:bg-panel"><X size={18} /></button></div>
            <p className="mb-4 text-[12.5px] text-muted">How much of each material <b>one piece</b> needs. Pick the exact variant (e.g. Sticker → Men, Zip → 8 inch).{!canManage && " (View only.)"}</p>

            {recipeLoading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-muted"><Loader2 size={18} className="animate-spin" /> Loading…</div>
            ) : (
              <>
                <div className="space-y-2.5">
                  {lines.map((l, i) => {
                    const grp = groupById(l.group_id);
                    return (
                      <div key={i} className="rounded-xl2 border border-line/70 p-2.5">
                        <div className="flex items-center gap-2">
                          <select value={l.group_id} disabled={!canManage} onChange={(e) => setLine(i, { group_id: e.target.value })} className={`${inpSm} flex-1`}>
                            <option value="">Choose material…</option>
                            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          </select>
                          {canManage && <button onClick={() => removeLine(i)} disabled={lines.length === 1} className="rounded-full p-1.5 text-muted hover:bg-danger-soft hover:text-danger disabled:opacity-30"><Trash2 size={14} /></button>}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          {grp?.has_category && (
                            <select value={l.category_id} disabled={!canManage} onChange={(e) => setLine(i, { category_id: e.target.value })} className={`${inpSm} min-w-[110px] flex-1`}>
                              <option value="">Category…</option>
                              {catsFor(l.group_id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                            </select>
                          )}
                          {grp?.has_size && (
                            <select value={l.size_id} disabled={!canManage} onChange={(e) => setLine(i, { size_id: e.target.value })} className={`${inpSm} min-w-[100px] flex-1`}>
                              <option value="">Size…</option>
                              {sizes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                            </select>
                          )}
                          <input type="number" step="any" value={l.quantity} disabled={!canManage} onChange={(e) => setLine(i, { quantity: e.target.value })} placeholder="per piece" className={`${inpSm} w-24`} />
                          <select value={l.unit_id} disabled={!canManage || !l.group_id} onChange={(e) => setLine(i, { unit_id: e.target.value })} className={`${inpSm} w-20`}>
                            <option value="">unit</option>
                            {unitsFor(l.group_id).map((u) => <option key={u.id} value={u.id}>{u.symbol}</option>)}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {canManage && <button onClick={addLine} className="mt-3 flex items-center gap-1 rounded-full border border-line px-3 py-1.5 text-[12.5px] font-semibold text-ink/70 hover:bg-panel"><Plus size={14} /> Add material</button>}
                {recipeErr && <p className="mt-3 text-[12.5px] font-medium text-danger">{recipeErr}</p>}
                {canManage && (
                  <div className="mt-5 flex justify-end gap-2">
                    <button onClick={() => setRecipeFor(null)} disabled={savingRecipe} className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
                    <button onClick={saveRecipe} disabled={savingRecipe} className="flex items-center gap-1.5 rounded-xl2 bg-ink px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">{savingRecipe && <Loader2 size={15} className="animate-spin" />}Save recipe</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {deleteFor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={() => !deleting && setDeleteFor(null)}>
          <div className="w-full max-w-sm rounded-card bg-surface p-6 shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-danger-soft text-danger"><Trash2 size={22} /></div>
            <h2 className="text-center text-[16px] font-extrabold">Delete this article?</h2>
            <p className="mt-1.5 text-center text-[13px] text-muted"><b className="text-ink">{deleteFor.name}</b> and its recipe will be permanently removed. This can&apos;t be undone.</p>
            {deleteErr && <p className="mt-3 rounded-xl2 bg-danger-soft px-3 py-2 text-center text-[12.5px] font-medium text-danger">{deleteErr}</p>}
            <div className="mt-5 flex justify-center gap-2">
              <button onClick={() => setDeleteFor(null)} disabled={deleting} className="rounded-xl2 border border-line px-4 py-2.5 text-[13px] font-semibold text-ink/70 hover:bg-panel">Cancel</button>
              <button onClick={doDelete} disabled={deleting} className="flex items-center gap-1.5 rounded-xl2 bg-danger px-5 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">{deleting && <Loader2 size={15} className="animate-spin" />}Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const inp = "mt-1.5 w-full rounded-xl2 border border-line bg-canvas px-3.5 py-2.5 text-[14px] outline-none placeholder:text-hint focus:border-salmon-strong/50";
const inpSm = "rounded-xl2 border border-line bg-canvas px-2.5 py-2 text-[13px] outline-none placeholder:text-hint focus:border-salmon-strong/50";
