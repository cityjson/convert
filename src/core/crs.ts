// Coordinate reference systems, as the extension reports and accepts them.

export interface Crs {
  authority: string;
  code: string;
}

/** `reference_system` from `*_metadata()`, or a PROJJSON `id`; extra keys are ignored. */
interface ReferenceSystem {
  authority?: string | null;
  code?: string | number | null;
  [key: string]: unknown;
}

/** From the `reference_system` struct that `*_metadata()` returns. */
export function crsFromReferenceSystem(rs: ReferenceSystem | null | undefined): Crs | undefined {
  if (!rs?.authority || rs.code == null || rs.code === "") return undefined;
  return { authority: String(rs.authority), code: String(rs.code) };
}

/** From the PROJJSON in a CityParquet footer (`cityparquet_city_field(city, 'crs')`). */
export function crsFromProjjson(projjson: string | null | undefined): Crs | undefined {
  if (!projjson) return undefined;
  try {
    const id = (JSON.parse(projjson) as { id?: ReferenceSystem }).id;
    return crsFromReferenceSystem(id);
  } catch {
    return undefined;
  }
}

/** The OGC URI form, which `COPY … (crs …)` writes into CityJSON. */
export function crsToUri(crs: Crs): string {
  return `https://www.opengis.net/def/crs/${crs.authority}/0/${crs.code}`;
}

/** The `AUTH:CODE` form, which `cityparquet_write(crs => …)` resolves. */
export function crsToAuthCode(crs: Crs): string {
  return `${crs.authority}:${crs.code}`;
}
