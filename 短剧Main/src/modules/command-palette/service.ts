import type {
  CommandPaletteActor,
  CommandPaletteRepository,
  CommandPaletteSearchResults,
} from "./types.js";
import { COMMAND_PALETTE_PER_GROUP_LIMIT } from "./types.js";

/**
 * Thin pass-through for now: visibility is enforced in SQL by the repository
 * (server-side backstop, S30 constraint), and the per-group cap is fixed here
 * so the route cannot be talked into returning whole tables.
 */
export class CommandPaletteService {
  constructor(private readonly repository: CommandPaletteRepository) {}

  search(actor: CommandPaletteActor, query: string): Promise<CommandPaletteSearchResults> {
    return this.repository.searchVisible(actor, query, COMMAND_PALETTE_PER_GROUP_LIMIT);
  }
}
