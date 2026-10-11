# Test fixtures

`delft_subset.city.jsonl` contains the first 20 features of the 3DBAG Delft tile
(<https://cityjson.open3d.city/cityjsonseq/delft.city.jsonl>). 3DBAG data © 3DBAG team,
licensed CC BY 4.0 (<https://3dbag.nl>).

The integration tests derive the other formats (CityJSON, FlatCityBuf, CityParquet
package) from this file at run time, so only one copy of the data is committed.

`cube.obj` / `cube.mtl` are the hand-written OBJ fixtures of
[duckdb-cityjson](https://github.com/cityjson/duckdb-cityjson) (`test/data/obj/`, MIT):
a closed unit cube with semantic-surface materials and a textured `brick` material,
plus an open slab.
