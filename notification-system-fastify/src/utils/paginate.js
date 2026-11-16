// Shared "page of rows + total count" for every list endpoint.
//
//   paginate(Reminder, { where, order, page: 2, limit: 10 })
//   -> { data: [...10 rows], pagination: { page: 2, limit: 10, total: 37, totalPages: 4 } }
//
// findAndCountAll runs the SELECT (with LIMIT/OFFSET) and the COUNT(*) for
// the same WHERE. Both use the same index, see docs/DATABASE.md.
async function paginate(Model, { where, order, page, limit }) {
  const { rows, count } = await Model.findAndCountAll({
    where,
    order,
    limit,
    offset: (page - 1) * limit,
  });

  return {
    data: rows,
    pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
  };
}

module.exports = { paginate };
