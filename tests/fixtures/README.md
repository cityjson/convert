# Test fixtures

`delft_subset.city.jsonl` contains the first 20 features of the 3DBAG Delft tile
(<https://cityjson.open3d.city/cityjsonseq/delft.city.jsonl>). 3DBAG data © 3DBAG team,
licensed CC BY 4.0 (<https://3dbag.nl>).

The integration tests derive the other formats (CityJSON, FlatCityBuf, CityParquet
package) from this file at run time, so only one copy of the data is committed.
