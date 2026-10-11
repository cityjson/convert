import logo from "@/assets/cityjson-logo.svg";
import { ConvertPage } from "@/features/convert/ConvertPage";

export function App() {
  return (
    <div className="min-h-dvh bg-muted">
      <header className="border-b bg-background">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-4">
          <a href="https://www.cityjson.org" aria-label="CityJSON home">
            <img src={logo} alt="CityJSON" className="h-7 w-auto" />
          </a>
          <span className="text-lg font-light text-foreground">Convert</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <div className="space-y-1">
          <h1 className="text-2xl font-light">Convert 3D city models</h1>
          <p>
            Between CityJSON, CityJSONSeq, FlatCityBuf, CityParquet and OBJ, keeping only the levels
            of detail and attributes you need.
          </p>
        </div>
        <ConvertPage />
        <footer className="space-y-1 text-xs">
          <p>
            Everything runs in your browser; files never leave your machine. Powered by{" "}
            <a href="https://duckdb.org/docs/api/wasm/overview">DuckDB-Wasm</a> and the{" "}
            <a href="https://github.com/cityjson/duckdb-cityjson">cityjson DuckDB extension</a>.
          </p>
          <p>
            Experimental: verify results before relying on them.{" "}
            <a href="https://github.com/cityjson/convert/issues">Report an issue</a>.
          </p>
        </footer>
      </main>
    </div>
  );
}
