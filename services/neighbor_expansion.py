from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class NeighborPage:
    source_id: str
    page_number: int
    anchor_page_number: int


def plan_neighbor_pages(
    seed_pages: list[tuple[str, int]],
    *,
    radius: int,
    max_total_pages: int,
) -> list[NeighborPage]:
    # Direct pages always keep priority. Adjacent pages are added by distance
    # and never replace a semantically retrieved page.

    direct: list[tuple[str, int]] = []
    seen_direct: set[tuple[str, int]] = set()

    for source_id, page_number in seed_pages:
        key = (source_id, page_number)
        if key in seen_direct:
            continue
        seen_direct.add(key)
        direct.append(key)

    remaining = max(0, max_total_pages - len(direct))
    if radius <= 0 or remaining <= 0:
        return []

    seen = set(direct)
    planned: list[NeighborPage] = []

    for distance in range(1, radius + 1):
        for source_id, anchor_page in direct:
            for page_number in (
                anchor_page - distance,
                anchor_page + distance,
            ):
                if page_number < 1:
                    continue
                key = (source_id, page_number)
                if key in seen:
                    continue
                seen.add(key)
                planned.append(
                    NeighborPage(
                        source_id=source_id,
                        page_number=page_number,
                        anchor_page_number=anchor_page,
                    )
                )
                if len(planned) >= remaining:
                    return planned

    return planned
