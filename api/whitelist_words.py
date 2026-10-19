# whitelist_words.py
"""
Server copy of the client's whitelist-code wordlist (app/src/utils/whitelistCode.ts).

The code is minted in the browser, but the server has to recognise one when it
arrives over WhatsApp or Telegram, so it can tell "pair this phone" apart from
"here is a message for my Observer session". tests/test_remote.py fails if the
two lists drift apart.
"""

WORDS = (
    "anchor", "apple", "arrow", "autumn", "badge", "banjo", "basil", "beacon",
    "bicycle", "binder", "birch", "bishop", "blanket", "blossom", "bramble", "brass",
    "breeze", "bridge", "bronze", "bucket", "bulb", "cabin", "candle", "canvas",
    "canyon", "cargo", "carpet", "cedar", "cellar", "chalk", "charcoal", "cherry",
    "chimney", "cinder", "clover", "cobalt", "compass", "copper", "coral", "cotton",
    "crater", "crayon", "crescent", "cricket", "crimson", "crystal", "dagger", "daisy",
    "dolphin", "dragon", "drift", "drum", "eagle", "ember", "engine", "falcon",
    "feather", "fennel", "ferry", "fiddle", "fiesta", "flame", "flannel", "flint",
    "forest", "fossil", "fountain", "foxglove", "frost", "garden", "garnet", "gazelle",
    "ginger", "glacier", "goblet", "granite", "gravel", "guitar", "gully", "hammer",
    "harbor", "harvest", "hazel", "hearth", "helmet", "heron", "hickory", "holly",
    "hornet", "hunter", "iceberg", "indigo", "ivory", "jacket", "jasper", "jigsaw",
    "jungle", "kettle", "kitten", "lagoon", "lantern", "lark", "lavender", "ledger",
    "lemon", "lentil", "lighthouse", "lilac", "linen", "lobster", "locket", "lumber",
    "magnet", "mallard", "mango", "maple", "marble", "marigold", "marsh", "meadow",
    "mint", "mitten", "monsoon", "mosaic", "moss", "mountain", "mustang", "nectar",
    "needle", "nettle", "nickel", "nimbus", "nutmeg", "oak", "oasis", "obsidian",
    "olive", "onyx", "opal", "orbit", "orchard", "osprey", "otter", "oxide",
    "paddle", "palace", "pansy", "parcel", "parsley", "pebble", "pelican", "pepper",
    "petal", "pheasant", "pickle", "pigeon", "pillow", "pilot", "pine", "pineapple",
    "pioneer", "pocket", "poplar", "poppy", "possum", "pottery", "prairie", "pretzel",
    "puddle", "pumpkin", "quartz", "quill", "quilt", "rabbit", "raccoon", "radish",
    "rainbow", "raven", "reed", "ribbon", "ripple", "river", "rocket", "rooster",
    "rosemary", "rubble", "ruby", "rustic", "saddle", "saffron", "sage", "salmon",
    "sandal", "sapling", "sapphire", "satin", "sawdust", "scarf", "shovel", "shrimp",
    "sienna", "silo", "sketch", "skylark", "sleigh", "sonnet", "sparrow", "spatula",
    "sphinx", "spinach", "spruce", "squirrel", "stable", "starling", "stone", "stork",
    "stump", "sunflower", "swallow", "syrup", "tabby", "tangerine", "tapestry", "tavern",
    "thistle", "thunder", "timber", "toffee", "tortoise", "trellis", "trumpet", "tulip",
    "tundra", "turnip", "turquoise", "turtle", "tusk", "umbrella", "valley", "velvet",
    "vessel", "violet", "walnut", "walrus", "warbler", "wasp", "wattle", "whistle",
    "willow", "windmill", "wisteria", "wombat", "wrench", "yarrow", "yew", "zephyr",
)
