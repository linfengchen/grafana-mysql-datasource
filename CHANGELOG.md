# Changelog

## 13.0.1
- Fix ad hoc filter key and value lookups scanning the whole table: the time anchor that bounds them was read from the query result by array index, which a `DataFrameView` does not support, so it was always empty.
- Fix the time anchors of tables probed together cancelling one another: every anchor request used the same `refId`, so only the last table's reached the database. Each table now has its own.

## 13.0.0
Initial public release of the external version

## 1.0.0 (Unreleased)

Initial release.
