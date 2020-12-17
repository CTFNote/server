import { randomBytes } from "crypto";
import jsonWebToken from "jsonwebtoken";

import { TeamModel, ITeamModel } from "../models/Team";
import { IUserModel, UserModel } from "../models/User";
import {
  BadRequestError,
  ConflictError,
  InternalServerError,
  NotFoundError,
  UnauthorizedError,
} from "../types/httperrors";
import {
  BasicInvite,
  InviteOptions,
  JWTData,
  TeamDetailsUpdateData,
} from "../types";
import config from "../config";
import Logger from "../loaders/logger";
import { ITeamInviteModel, TeamInviteModel } from "../models/TeamInvite";
import { basicInvite } from "../util";

export default class TeamService {
  /**
   * create a new team
   *
   * @param {string} jwt the JWT of the user creating the team
   * @param {string} teamName the name of the team
   * @returns {Promise<{ teamName: string; teamID: string }>} returns the team data
   * @memberof TeamService
   */
  public async createTeam(
    jwt: string,
    teamName: string
  ): Promise<{ teamName: string; teamID: string }> {
    // TODO: Turn this into a proper type

    const teamExists = await TeamModel.exists({
      name: teamName.toLowerCase(),
    }).then();

    if (teamExists) throw new ConflictError({ errorCode: "error_team_exists" });

    /* eslint-disable-next-line */
    let decodedJWT: string | object;
    try {
      decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
    } catch {
      throw new BadRequestError({ errorMessage: "Invalid JWT" });
    }

    const owner = await UserModel.findById((decodedJWT as JWTData).id).then();

    const team = await TeamModel.create({
      name: teamName.toLowerCase(),
      owner,
      members: undefined,
      socials: undefined,
      CTFs: undefined,
      invites: [],
    }).catch((err) => {
      Logger.error(`Error while creating team: ${err}`);
      throw new InternalServerError();
    });

    owner.teams.push(team);

    team.save();
    owner.save();

    return { teamName: team.name, teamID: team._id };
  }

  /**
   * Get's a team's information. By default only allows to get info if the user is in the team, but admins can always get the team details
   *
   * @async
   * @param {string} jwt the JWT of the user trying to get team details
   * @param {string} teamID the ID of the team that is getting fetched
   * @memberof TeamService
   */
  public async getTeam(jwt: string, teamID: string): Promise<ITeamModel> {
    /* eslint-disable-next-line */
    let decodedJWT: string | object;
    try {
      decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
    } catch {
      throw new BadRequestError({ errorMessage: "Invalid JWT" });
    }

    const user = await (await UserModel.findById((decodedJWT as JWTData).id))
      .execPopulate()
      .then()
      .catch((err) => {
        Logger.error(err);
        throw new InternalServerError();
      });

    const team = await TeamModel.findById(teamID);
    if (!team) throw new NotFoundError({ errorCode: "error_team_not_found" });

    if (!user.isAdmin) {
      if (!team.inTeam(user)) {
        throw new UnauthorizedError({ errorCode: "error_invalid_permissionseeeee"  });
      }
    }

    return team;
  }

  /**
   * update team details
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the id of the team being modified
   * @param {TeamDetailsUpdateData} newDetails the new team details
   * @returns {Promise<ITeamModel>} the new team
   * @memberof TeamService
   */
  public async updateTeam(
    jwt: string,
    teamID: string,
    newDetails: TeamDetailsUpdateData
  ): Promise<ITeamModel> {
    const team = await this.getTeam(jwt, teamID);

    if (newDetails.name) team.name = newDetails.name;

    if (newDetails.socials?.twitter)
      team.socials.twitter = newDetails.socials.twitter;

    if (newDetails.socials?.website)
      team.socials.website = newDetails.socials.twitter;

    await team.save().catch((err) => {
      Logger.warn(err);
      throw new InternalServerError();
    });

    return team;
  }

  /**
   * change the team owner
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the ID of the team being modified
   * @param {string} newOwnerID the ID of the new owner
   * @returns {Promise<ITeamModel>} the new team
   * @memberof TeamService
   */
  public async updateOwner(
    jwt: string,
    teamID: string,
    newOwnerID: string
  ): Promise<ITeamModel> {
    let team: ITeamModel;
    let oldOwner: IUserModel;
    let newOwner: IUserModel;

    await Promise.all([
      this.getTeam(jwt, teamID),
      UserModel.findById((jsonWebToken.decode(jwt) as JWTData).id),
      UserModel.findById(newOwnerID),
    ])
      .then(async (results) => {
        console.log(results);

        team = await results[0]
          .populate("owner")
          .populate("members")
          // .populate("CTFs")
          .execPopulate();
        oldOwner = await results[1].populate("teams").execPopulate();
        newOwner = await results[2].populate("teams").execPopulate();
      })
      .catch((err) => {
        throw err;
      });

    const decodedJWT = jsonWebToken.decode(jwt) as JWTData;

    if (!decodedJWT.isAdmin) {
      if (!(team.inTeam(newOwner))) {
        throw new BadRequestError({
          errorMessage:
            "New owner must be in team before transfer of ownership",
        });
      }

      if (!team.isOwner(oldOwner)) {
        throw new BadRequestError({
          errorMessage: "Cannot transfer ownership",
          errorCode: "error_user_not_owner",
        });
      }
    }
    team.owner = newOwner;
    await team.save();

    await team.depopulate("owner").depopulate("members").execPopulate();

    return team;
  }

  /**
   * create an invite to the team
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the id of the team being modified
   * @param {InviteOptions} inviteOptions options for the invite
   * @returns {Promise<ITeamInviteModel>} the invite created
   * @memberof TeamService
   */
  public async createInvite(
    jwt: string,
    teamID: string,
    inviteOptions: InviteOptions
  ): Promise<ITeamInviteModel> {
    /* eslint-disable-next-line */
    let decodedJWT: string | object;
    try {
      decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
    } catch {
      throw new BadRequestError({ errorMessage: "Invalid JWT" });
    }

    let user: IUserModel;
    let team: ITeamModel;
    await Promise.all([
      UserModel.findById((decodedJWT as JWTData).id),
      TeamModel.findById(teamID),
    ])
      .then((results) => {
        user = results[0];
        team = results[1];
      })
      .catch((err) => {
        throw err;
      });

    if (!user.isAdmin) {
      if (!team.isOwner(user)) {
        throw new BadRequestError({
          errorMessage: "Only the team owner can create invites",
          errorCode: "error_invalid_permissions",
        });
      }
    }

    const invite = new TeamInviteModel({
      team: team._id,
      inviteCode: randomBytes(3).toString("hex"),
      expiry: inviteOptions.expiry ? inviteOptions.expiry : undefined,
      maxUses: inviteOptions.maxUses ? inviteOptions.maxUses : undefined,
      createdAt: new Date(),
      createdByUser: user._id,
      uses: [],
    });

    if (!team.invites) {
      team.invites = [];
    }

    team.invites.push(invite._id);

    await invite.save();
    await team.save();

    return invite;
  }

  /**
   * gets an invite
   *
   * @param {(string | undefined)} jwt the JWT of the user performind the operation, if present
   * @param {string} inviteID the ID of the invite being requested
   * @returns {(Promise<ITeamInviteModel | BasicInvite>)} return either a basic invite for normal users or a complete invite for admins
   * @memberof TeamService
   */
  public async getInvite(
    jwt: string | undefined,
    inviteID: string
  ): Promise<ITeamInviteModel | BasicInvite> {
    const invite = await TeamInviteModel.findOne({ inviteCode: inviteID });

    let user: IUserModel;
    if (jwt) {
      /* eslint-disable-next-line */
      let decodedJWT: string | object;
      try {
        decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
      } catch {
        throw new BadRequestError({ errorMessage: "Invalid JWT" });
      }

      user = await UserModel.findById((decodedJWT as JWTData).id);
    }

    if (!user?.isAdmin) {
      if (
        invite.uses.length >= invite.maxUses ||
        new Date() >= new Date(invite.expiry)
      ) {
        throw new BadRequestError({ errorCode: "error_expired_invite" });
      }

      return basicInvite(invite);
    }
    return invite;
  }

  /**
   * deletes an invite
   *
   * @param {string} jwt the ID of the user performing the operation
   * @param {string} inviteID the invite to delete's ID
   * @returns {Promise<void>} void
   * @memberof TeamService
   */
  public async deleteInvite(jwt: string, inviteID: string): Promise<void> {
    /* eslint-disable-next-line */
    let decodedJWT: string | object;
    try {
      decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
    } catch {
      throw new BadRequestError({ errorMessage: "Invalid JWT" });
    }

    const user = await UserModel.findById((decodedJWT as JWTData).id);
    const invite = await TeamInviteModel.findOne({ inviteCode: inviteID });

    if (!invite) {
      throw new NotFoundError({ errorMessage: "Invite not found" });
    }

    const team = invite.team;

    if (!user.isAdmin) {
      if (!team.isOwner(user)) {
        throw new BadRequestError({ errorCode: "error_invalid_permissions" });
      }
    }

    await invite.delete();
  }

  /**
   * uses an invite and adds a user to the team
   *
   * @param {string} jwt the JWT of the user performing the operation. This is the user that will be added to the team
   * @param {string} inviteID the ID of the team in question
   * @returns {Promise<ITeamModel>} the team the user was added to
   * @memberof TeamService
   */
  public async useInvite(jwt: string, inviteID: string): Promise<ITeamModel> {
    /* eslint-disable-next-line */
    let decodedJWT: string | object;
    try {
      decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
    } catch {
      throw new BadRequestError({ errorMessage: "Invalid JWT" });
    }

    const user = await UserModel.findById((decodedJWT as JWTData).id);
    const invite = await TeamInviteModel.findOne({ inviteCode: inviteID });

    if (!invite) throw new NotFoundError({ errorMessage: "Invite not found" });

    const team = invite.team;

    team.members.push(user._id);
    user.teams.push(team._id);
    invite.uses.push(user._id);

    Promise.all([team.save(), user.save(), invite.save()])
      .then()
      .catch((err) => {
        throw err;
      });

    return team;
  }

  /**
   * removes a user from a team
   *
   * @param {string} jwt the JWT of the user to remove
   * @param {string} teamID the ID of the team
   * @returns {Promise<void>} void
   * @memberof TeamService
   */
  public async leaveTeam(jwt: string, teamID: string): Promise<void> {
    /* eslint-disable-next-line */
    let decodedJWT: string | object;
    try {
      decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
    } catch {
      throw new BadRequestError({ errorMessage: "Invalid JWT" });
    }

    const user = await UserModel.findById((decodedJWT as JWTData).id);
    const team = await TeamModel.findById(teamID);

    if (!team) throw new NotFoundError({ errorCode: "error_team_not_found" });

    if (team.isOwner(user))
      throw new ConflictError({
        errorMessage: "Owner may not leave team",
        details:
          "The owner of a team cannot leave it without first changing the owner to a different member",
      });

    if (!team.inTeam(user))
      throw new ConflictError({
        errorMessage: "Cannot leave team",
        errorCode: "error_not_in_team",
      });

    team.members = team.members.splice(team.members.indexOf(user._id), 1);
    user.teams = user.teams.splice(user.teams.indexOf(team._id), 1);

    team.save();
    user.save();

    return;
  }

  /**
   * deletes a team. Only the team owner and admins can delete a team
   *
   * @param {string} jwt the JWT of the user performing the operation
   * @param {string} teamID the team to be deleted
   * @returns {Promise<void>} void
   * @memberof TeamService
   */
  public async deleteTeam(jwt: string, teamID: string): Promise<void> {
    /* eslint-disable-next-line */
    let decodedJWT: string | object;
    try {
      decodedJWT = jsonWebToken.verify(jwt, config.get("jwt.secret"));
    } catch {
      throw new BadRequestError({ errorMessage: "Invalid JWT" });
    }

    const user = await UserModel.findById((decodedJWT as JWTData).id);
    const team = await TeamModel.findById(teamID);

    if (!user.isAdmin) {
      if (!team.isOwner(user))
        throw new BadRequestError({
          errorCode: "error_invalid_permissions",
          errorMessage: "Only the team owner can delete the team",
        });
    }

    user.teams = user.teams.splice(user.teams.indexOf(team._id), 1);

    for (const member of team.members) {
      member.teams = member.teams.splice(member.teams.indexOf(team._id), 1);
      member.save();
    }

    await user.save();
    await team.delete();

    return;
  }
}
