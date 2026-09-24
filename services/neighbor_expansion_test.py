from neighbor_expansion import plan_neighbor_pages


def keys(items):
    return [
        (
            item.source_id,
            item.page_number,
            item.anchor_page_number,
        )
        for item in items
    ]


assert keys(
    plan_neighbor_pages(
        [
            ("medical", 19),
            ("medical", 18),
            ("medical", 20),
            ("medical", 15),
        ],
        radius=1,
        max_total_pages=7,
    )
) == [
    ("medical", 17, 18),
    ("medical", 21, 20),
    ("medical", 14, 15),
]

assert keys(
    plan_neighbor_pages(
        [("a", 1)],
        radius=1,
        max_total_pages=3,
    )
) == [
    ("a", 2, 1),
]

assert (
    plan_neighbor_pages(
        [
            ("a", 4),
            ("a", 5),
        ],
        radius=1,
        max_total_pages=2,
    )
    == []
)

print("neighbor-expansion tests passed")
